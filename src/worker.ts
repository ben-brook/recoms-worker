import { v4 as uuidv4 } from 'uuid';
import { parse } from 'cookie';

const UPDATE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;
const AUTH_COOKIE_MAX_AGE_S = 86400 * 365;
const AUTH_COOKIE_NAME = 'authCookie';
const HISTORY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

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
		// ON CONFLICT is a SQLite feature and isn't standard.
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

type HistoryCols = { productid: string; lastvisited: number };
function handleHistory(headers: Headers, productId: string, env: Env): [Promise<D1Result<HistoryCols>>, string | null] {
	const cookies = parse(headers.get('Cookie') || '');
	let authCookie = cookies[AUTH_COOKIE_NAME];
	let didMakeCookie = false;
	let promise: Promise<D1Result<HistoryCols>>;
	if (authCookie) {
		promise = env.DB.prepare('SELECT productid, lastvisited FROM userhistory WHERE cookie = ?1').bind(authCookie).all();
	} else {
		promise = new Promise(() => ({ success: true, results: [] }));
		didMakeCookie = true;
		authCookie = uuidv4();
	}

	addToHistory(productId, authCookie, env);

	return [promise, didMakeCookie ? authCookie : null];
}

type ProductCols = { classification: string; lastupdated: number };
async function handleClassification(productId: string, env: Env, ctx: ExecutionContext): Promise<string> {
	const { success, results } = await env.DB.prepare('SELECT classification, lastupdated FROM products WHERE productid = ?1')
		.bind(productId)
		.all();
	if (!success) throw new Error('Failed to check for product classification');
	// The type is guranteed by the Client API.
	const classResults = results as ProductCols[];

	let classification: string;
	if (!classResults || classResults.length == 0) {
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

async function fetchSimilar(productId: string, classification: string, env: Env): Promise<string[]> {
	let { success: sameSuccess, results: sameResults } = await env.DB.prepare(
		'SELECT productid FROM products WHERE classification = ?1 AND NOT productid = ?2'
	)
		.bind(classification, productId)
		.all();
	if (!sameSuccess) throw new Error('Failed to find similar products');
	// This typing is guaranteed from the SQL statement.
	const productIdObjs = sameResults as { productid: string }[];
	return productIdObjs.map(({ productid }) => productid);
}

export interface Env {
	DB: D1Database;
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const reqBody = await parseRequest(request);
		const [historyPromise, newCookie] = handleHistory(request.headers, reqBody.id, env);
		const classification = await handleClassification(reqBody.id, env, ctx);
		const similar = await fetchSimilar(reqBody.id, classification, env);

		const { success: historySuccess, results: historyResults } = await historyPromise;
		// Maybe we should handle this earlier to save on redundant HTTP requests.
		if (!historySuccess) throw new Error('Failed to get user history');
		// TODO: do something with this (recommender system)
		// This typing is guaranteed from the SQL statement.
		const historyObjs = (historyResults as HistoryCols[]).sort((a, b) => a.lastvisited - b.lastvisited);

		let recommendations = `<ul class="list-group list-group-horizontal">\n`;
		for (const id of similar) {
			recommendations += `<a class="list-group-item" href="/products/${id}">An item</a>`;
		}
		recommendations += `<a class="list-group-item" href="/products/2">Sushi</a>`; // TODO: remove
		recommendations += '</ul>';

		const json = JSON.stringify({ recommendations });
		const response = new Response(json);
		response.headers.set('content-type', 'application/json;charset=UTF-8');
		if (newCookie) {
			response.headers.set('Set-Cookie', `${AUTH_COOKIE_NAME}=${newCookie}; Max-Age=${AUTH_COOKIE_MAX_AGE_S}; path=/; secure`);
		}
		return response;
	},

	async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
		await env.DB.prepare(`DELETE FROM userhistory WHERE ?1 - lastvisited > ${HISTORY_MAX_AGE_MS}`).bind(Date.now()).run();
	},
};
