/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

const updateThresholdMs = 7 * 24 * 60 * 60 * 1000;

export interface Env {
	DB: D1Database;

	// Example binding to KV. Learn more at https://developers.cloudflare.com/workers/runtime-apis/kv/
	// MY_KV_NAMESPACE: KVNamespace;
	//
	// Example binding to Durable Object. Learn more at https://developers.cloudflare.com/workers/runtime-apis/durable-objects/
	// MY_DURABLE_OBJECT: DurableObjectNamespace;
	//
	// Example binding to R2. Learn more at https://developers.cloudflare.com/workers/runtime-apis/r2/
	// MY_BUCKET: R2Bucket;
	//
	// Example binding to a Service. Learn more at https://developers.cloudflare.com/workers/runtime-apis/service-bindings/
	// MY_SERVICE: Fetcher;
	//
	// Example binding to a Queue. Learn more at https://developers.cloudflare.com/queues/javascript-apis/
	// MY_QUEUE: Queue;
}

interface ReqBody {
	pic: string;
	id: string;
}
function isReqBody(object: any): object is ReqBody {
	return 'pic' in object && typeof object.pic == 'string' && 'id' in object && typeof object.id == 'string';
}

const tempClassificationMap: { [id: string]: string } = {
	'1': 'clothing',
	'2': 'food',
};
async function classify(reqBody: ReqBody, env: Env): Promise<string> {
	// Interface Constellation when we get access, but for now...
	const classification = tempClassificationMap[reqBody.id];

	const { success } = await env.DB.prepare('INSERT INTO Products (ProductId, Classification, Updated) VALUES (?1, ?2, ?3)')
		.bind(reqBody.id, classification, Date.now())
		.run();
	if (!success) throw new Error('Failed to register classification');

	return classification;
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const encodedReqBody = await request.text();
		const reqBody = JSON.parse(decodeURIComponent(encodedReqBody));
		if (!isReqBody(reqBody)) throw new Error('Request body is wrong');

		const { success: classSuccess, results: classResults } = await env.DB.prepare(
			'SELECT Classification, Updated FROM Products WHERE ProductId = ?1'
		)
			.bind(reqBody.id)
			.all();
		if (!classSuccess) throw new Error('Failed to check for product classification');

		let classification: string;
		if (classResults === undefined) {
			// The picture has never been classified before.
			classification = await classify(reqBody, env);
		} else {
			// This typing is guaranteed from the SQL statement.
			const { Classification: storedClass, Updated: updated } = classResults[0] as { Classification: string; Updated: number };
			classification = storedClass;
			if (Date.now() - updated >= updateThresholdMs) {
				// We classify the picture for next time, but don't wait for it to be classified this time.
				classify(reqBody, env);
			}
		}

		let { success: sameSuccess, results: sameResults } = await env.DB.prepare(
			'SELECT ProductId FROM Products WHERE Classification = ?1 AND NOT ProductId = ?2'
		)
			.bind(classification, reqBody.id)
			.all();
		if (!sameSuccess) throw new Error('Failed to find similar products');
		if (sameResults === undefined) {
			sameResults = [];
		}
		// This typing is guaranteed from the SQL statement.
		const productIdObjs = sameResults as [{ ProductId: string }];

		const json = JSON.stringify({
			recommendations: productIdObjs.map(({ ProductId: productId }) => productId).join(', '),
		});
		return new Response(json, {
			headers: {
				'content-type': 'application/json;charset=UTF-8',
			},
		});
	},
};
