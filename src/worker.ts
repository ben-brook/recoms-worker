import { v4 as uuidv4 } from 'uuid';
import { parse } from 'cookie';

const UPDATE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1_000;
const AUTH_COOKIE_MAX_AGE_S = 86_400 * 365;
const AUTH_COOKIE_NAME = 'authCookie';
const HISTORY_MAX_AGE_MS = 27 * 24 * 60 * 60 * 1_000;
const HISTORY_LAMBDA = 0.1;
const HISTORY_LIMIT = 20;
const NUM_RECOMMENDATIONS = 2;

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
async function classify(productId: string, env: Env): Promise<string> {
	// TODO: Interface Constellation when we get access, but for now...
	const classification = tempClassificationMap[productId];
	const { success } = await env.DB.prepare(
		// ON CONFLICT is an SQLite feature and isn't standard.
		`INSERT INTO products VALUES (?1, ?2, ?3)
    	ON CONFLICT(productid) DO UPDATE SET
        	classification = excluded.classification,
        	lastupdated = excluded.lastupdated`
	)
		.bind(productId, classification, Date.now())
		.run();
	if (!success) throw new Error('Failed to register classification');

	return classification;
}

async function addToHistory(productId: string, cookie: string, env: Env) {
	const { success } = await env.DB.prepare(
		`INSERT INTO userhistory VALUES (?1, ?2, ?3)
		ON CONFLICT(cookie, productid) DO UPDATE SET
			lastvisited = excluded.lastvisited`
	)
		.bind(cookie, productId, Date.now())
		.run();

	if (!success) throw new Error('Failed to add product to history');
}

async function parseRequest(request: Request): Promise<ReqBody> {
	const { pathname } = new URL(request.url);
	if (pathname !== '/api/recommendations') {
		throw new Error('Unrecognised pathname');
	}
	const encodedReqBody = await request.text();
	const reqBody = JSON.parse(decodeURIComponent(encodedReqBody));
	if (!isReqBody(reqBody)) throw new Error('Request body is wrong');
	return reqBody;
}

interface Result {
	success: boolean;
	results?: HistoryCols[];
}
interface HistoryCols {
	productid: string;
	lastvisited: number;
	classification: string;
	lastupdated: number;
}
function handleHistory(headers: Headers, productId: string, env: Env, ctx: ExecutionContext): [Promise<Result>, string | null] {
	const cookies = parse(headers.get('Cookie') || '');
	let authCookie = cookies[AUTH_COOKIE_NAME];
	let didMakeCookie = false;
	let promise: Promise<Result>;
	if (authCookie) {
		promise = env.DB.prepare(
			`SELECT
				userhistory.productid,
				userhistory.lastvisited,
				products.classification,
				products.lastupdated
			FROM userhistory
			INNER JOIN products USING (productid)
			WHERE cookie = ?2 AND NOT productid = ?1
			ORDER BY lastvisited DESC LIMIT ?3`
		)
			.bind(productId, authCookie, HISTORY_LIMIT)
			.all();

		promise.then(({ success, results }) => {
			if (!success) return;
			for (const result of (results as HistoryCols[]).filter((result) => Date.now() - result.lastupdated >= UPDATE_THRESHOLD_MS)) {
				// We classify the picture for next time, but don't wait for it to be classified this time.
				ctx.waitUntil(classify(result.productid, env));
			}
		});
	} else {
		promise = new Promise((resolve) => {
			resolve({ success: true, results: [] });
		});
		didMakeCookie = true;
		authCookie = uuidv4();
	}

	addToHistory(productId, authCookie, env);

	return [promise, didMakeCookie ? authCookie : null];
}

interface ProductCols {
	classification: string;
	lastupdated: number;
}
async function handleClassification(productId: string, env: Env, ctx: ExecutionContext): Promise<string> {
	const { success, results } = await env.DB.prepare('SELECT classification, lastupdated FROM products WHERE productid = ?1')
		.bind(productId)
		.all();
	if (!success) throw new Error('Failed to check for product classification');
	const classResults = results as ProductCols[]; // Safe by Client API

	let classification: string;
	if (!classResults || classResults.length === 0) {
		// The picture has never been classified before.
		classification = await classify(productId, env);
	} else {
		const { classification: storedClass, lastupdated } = classResults[0];
		classification = storedClass;
		if (Date.now() - lastupdated >= UPDATE_THRESHOLD_MS) {
			// We classify the picture for next time, but don't wait for it to be classified this time.
			ctx.waitUntil(classify(productId, env));
		}
	}

	return classification;
}

async function fetchSimilar(classification: string, env: Env, productId: string | null = null): Promise<string[]> {
	let ready;
	if (productId === null) {
		ready = env.DB.prepare('SELECT productid FROM products WHERE classification = ?1').bind(classification);
	} else {
		ready = env.DB.prepare('SELECT productid FROM products WHERE classification = ?1 AND NOT productid = ?2').bind(
			classification,
			productId
		);
	}
	const { success: sameSuccess, results: sameResults } = await ready.all();

	if (!sameSuccess) throw new Error('Failed to find similar products');
	const productIdObjs = sameResults as { productid: string }[]; // Safe
	return productIdObjs.map(({ productid }) => productid);
}

function calcClassToWeight(curClass: string, historyResults: HistoryCols[]) {
	const historyObjs = historyResults.sort((a, b) => a.lastvisited - b.lastvisited);
	const classToWeight: Record<string, number> = {};

	let total = 0;
	for (const [i, classification] of [curClass]
		// The current product should get shift to the front.
		.concat(historyObjs.map(({ classification }) => classification))
		.entries()) {
		// We integrate the exponential distribution.
		const increase = (Math.exp(HISTORY_LAMBDA) - 1) / Math.exp(HISTORY_LAMBDA * (i + 1));
		classToWeight[classification] = increase + (classToWeight[classification] || 0);
		total += increase;
	}

	const scale = 1 / total;
	for (const classification of Object.keys(classToWeight)) {
		// Scale each weight up such that the total weight is 1. This doesn't feel like the best approach.
		classToWeight[classification] *= scale;
		console.log(`${classification}: ${classToWeight[classification]}`);
	}

	return classToWeight;
}

function removeFromWeighted(weightedProducts: [string[], number][], idx: number) {
	const weight = weightedProducts[idx][1];
	weightedProducts.splice(idx, 1);
	for (const [i, [_, otherWeight]] of weightedProducts.entries()) {
		// We set the total area to 1 again.
		weightedProducts[i][1] = otherWeight / (1 - weight);
	}
}

async function cbf(
	classToWeight: Record<string, number>,
	similarPromise: Promise<string[]>,
	curClass: string,
	env: Env
): Promise<string[]> {
	const weightedProducts = (await Promise.all(
		Object.entries(classToWeight).map(([classification, weight]) =>
			(classification === curClass ? similarPromise : fetchSimilar(classification, env)).then((products) => [products, weight])
		)
	)) as [string[], number][];

	if (weightedProducts[0][0].length === 0) {
		removeFromWeighted(weightedProducts, 0);
	}

	const similar = [];
	const upper = Math.min(
		NUM_RECOMMENDATIONS,
		weightedProducts.reduce((count, [products]) => count + products.length, 0) // Number of products
	);
	for (let it = 0; it < upper; it++) {
		let bar = 0;
		whileLoop: while (true) {
			const rand = Math.random();
			for (const [i, [products, weight]] of weightedProducts.entries()) {
				if (rand - bar > weight && i !== weightedProducts.length - 1 /* in case of floating point weirdness */) {
					bar += weight;
					continue;
				}

				const idx = Math.floor(Math.random() * products.length);
				const product = products[idx];
				// Efficiently remove product from array.
				products[idx] = products[products.length - 1];
				products.pop();
				similar.push(product);

				if (products.length === 0) {
					// This is fine since we're breaking out of the for loop immediately after.
					removeFromWeighted(weightedProducts, i);
				}
				break whileLoop;
			}
		}
	}

	return similar;
}

export interface Env {
	DB: D1Database;
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const reqBody = await parseRequest(request);
		const [historyPromise, newCookie] = handleHistory(request.headers, reqBody.id, env, ctx);
		const productClass = await handleClassification(reqBody.id, env, ctx);
		const similarPromise = fetchSimilar(productClass, env, reqBody.id);

		const { success: historySuccess, results: historyResults } = await historyPromise;
		// Maybe we should handle this earlier to save on redundant HTTP requests.
		if (!historySuccess) throw new Error('Failed to get user history');

		// Content-based filtering -- still not sure if all this is bug-free.
		const classToWeight = calcClassToWeight(productClass, historyResults as HistoryCols[] /* safe */);
		const similar = await cbf(classToWeight, similarPromise, productClass, env);

		let recommendations = `<ul class="list-group list-group-horizontal">\n`;
		for (const id of similar) {
			recommendations += `<a class="list-group-item" href="/products/${id}">An item</a>\n`;
		}
		recommendations += '</ul>';

		const json = JSON.stringify({ recommendations });
		const response = new Response(json);
		response.headers.set('content-type', 'application/json;charset=UTF-8');
		if (newCookie) {
			response.headers.set('Set-Cookie', `${AUTH_COOKIE_NAME}=${newCookie}; Max-Age=${AUTH_COOKIE_MAX_AGE_S}; path=/; secure`);
		}
		return response;
	},

	async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext) {
		await env.DB.prepare(`DELETE FROM userhistory WHERE ?1 - lastvisited > ${HISTORY_MAX_AGE_MS}`).bind(Date.now()).run();
	},
};
