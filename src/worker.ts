import { v4 as uuidv4 } from 'uuid';
import { parse } from 'cookie';

const UPDATE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;
const AUTH_COOKIE_NAME = 'authCookie';

interface ReqBody {
	pic: string;
	id: string;
}
function isReqBody(o: any): o is ReqBody {
	return 'pic' in o && typeof o.pic === 'string' && 'id' in o && typeof o.id === 'string';
}

const tempClassificationMap: { [id: string]: string } = {
	'1': 'clothing',
	'2': 'food',
};
async function classify(reqBody: ReqBody, env: Env): Promise<string> {
	// TODO: Interface Constellation when we get access, but for now...
	const classification = tempClassificationMap[reqBody.id];
	const { success } = await env.DB.prepare('insert into Products (ProductId, Classification, Updated) VALUES (?1, ?2, ?3)')
		.bind(reqBody.id, classification, Date.now())
		.run();
	if (!success) throw new Error('Failed to register classification');

	return classification;
}

export interface Env {
	DB: D1Database;
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const { pathname } = new URL(request.url);
		if (pathname === '/api/cookie') {
			return new Response(JSON.stringify({ cookie: uuidv4() }), { headers: { 'content-type': 'application/json;charset=UTF-8' } });
		} else if (pathname !== '/api/recommendations') {
			throw new Error('Unrecognised pathname');
		}

		const encodedReqBody = await request.text();
		const reqBody = JSON.parse(decodeURIComponent(encodedReqBody));
		if (!isReqBody(reqBody)) throw new Error('Request body is wrong');

		const cookies = parse(request.headers.get('Cookie') || '');
		const authCookie = cookies[AUTH_COOKIE_NAME];
		const historyPromise = env.DB.prepare('select Product, LastVisited from UserHistory where Cookie = ?1').bind(authCookie).all();

		const { success: classSuccess, results: classResults } = await env.DB.prepare(
			'select Classification, Updated from Products where ProductId = ?1'
		)
			.bind(reqBody.id)
			.all();
		if (!classSuccess) throw new Error('Failed to check for product classification');

		let classification: string;
		if (!classResults || classResults.length == 0) {
			// The picture has never been classified before.
			classification = await classify(reqBody, env);
		} else {
			// This typing is guaranteed from the SQL statement.
			const { Classification: storedClass, Updated: updated } = classResults[0] as { Classification: string; Updated: number };
			classification = storedClass;
			if (Date.now() - updated >= UPDATE_THRESHOLD_MS) {
				// We classify the picture for next time, but don't wait for it to be classified this time.
				// TODO: update instead of insert here
				classify(reqBody, env);
			}
		}

		let { success: sameSuccess, results: sameResults } = await env.DB.prepare(
			'select ProductId from Products where Classification = ?1 and not ProductId = ?2'
		)
			.bind(classification, reqBody.id)
			.all();
		if (!sameSuccess) throw new Error('Failed to find similar products');
		if (sameResults === undefined) {
			sameResults = [];
		}
		// This typing is guaranteed from the SQL statement.
		const productIdObjs = sameResults as [{ ProductId: string }];

		const { success: historySuccess, results: historyResults } = await historyPromise;
		if (!historySuccess) {
			// Maybe we should handle this earlier to save on redundant HTTP requests.
			throw new Error('Failed to get user history');
		}
		// This typing is guaranteed from the SQL statement.
		const historyObjs = historyResults as [{ Product: string; LastVisited: number }];
		historyObjs.sort((a, b) => a.LastVisited - b.LastVisited);

		const json = JSON.stringify({
			recommendations: productIdObjs.map(({ ProductId: productId }) => productId).join(', ') + '; ' + authCookie,
		});
		return new Response(json, { headers: { 'content-type': 'application/json;charset=UTF-8' } });
	},
};
