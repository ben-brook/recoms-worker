/* eslint-disable @typescript-eslint/no-explicit-any */
import { v4 as uuidv4 } from 'uuid';
import { parse } from 'cookie';
// @ts-expect-error: Constellation is currently untyped.
import { Tensor, run } from '@cloudflare/constellation';
import { imagenetClasses } from './imagenet';
// @ts-expect-error: pngjs/browser's types don't work.
import { PNG } from 'pngjs/browser';
import str from 'string-to-stream';

const UPDATE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1_000;
const AUTH_COOKIE_MAX_AGE_S = 86_400 * 365;
const AUTH_COOKIE_NAME = 'id-cookie';
const HISTORY_MAX_AGE_MS = 27 * 24 * 60 * 60 * 1_000;
const HISTORY_LAMBDA = 0.1;
const HISTORY_LIMIT = 40;
const NUM_RECOMMENDATIONS = 6;
const MODEL_ID = 'cdfb1bfb-37b2-4678-84b8-f05cc695d780';

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const reqBody = await parseRequest(request);
		const [historyPromise, newCookie] = await handleHistory(request.headers, reqBody.id, env);
		const productClass = await handleClassification(reqBody, env, ctx);
		const similarPromise = fetchSimilar(productClass, env, reqBody.id);

		const { success: historySuccess, results: historyResults } = await historyPromise;
		// Maybe we should handle this earlier to save on redundant HTTP requests.
		if (!historySuccess) throw new Error('Failed to get user history');

		// Content-based filtering -- still not sure if all this is bug-free.
		const classToWeight = calcClassToWeight(productClass, historyResults as HistoryCols[] /* safe */);
		const similar = await cbf(classToWeight, similarPromise, productClass, env);

		let recommendations = `<ul class="list-group list-group-horizontal"> ${productClass}\n`;
		for (const id of similar) {
			recommendations += `<a class="list-group-item" href="/products/${id[0]}">
	${id[1]}
	<span class="pull-left ">
        <img src="${id[2]}" class="img-reponsive img-rounded" style="width:100px; height:100px;" />
    </span>
</a>\n`;
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

	async scheduled(_event: ScheduledEvent, env: Env) {
		await env.DB.prepare(`DELETE FROM userhistory WHERE ?1 - lastvisited > ${HISTORY_MAX_AGE_MS}`).bind(Date.now()).run();
	},
};

export interface Env {
	DB: D1Database;
	// Constellation is currently untyped.
	CLASSIFIER: any;
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

interface ReqBody {
	pic: string;
	id: string;
	name: string;
}
function isReqBody(o: unknown): o is ReqBody {
	return (
		isObject(o) &&
		'pic' in o &&
		typeof o.pic === 'string' &&
		'id' in o &&
		typeof o.id === 'string' &&
		'name' in o &&
		typeof o.name === 'string'
	);
}

function isObject(o: unknown): o is Record<string, unknown> {
	return typeof o === 'object' && o !== null;
}

async function handleHistory(headers: Headers, productId: string, env: Env): Promise<[Promise<Result>, string | null]> {
	const cookies = parse(headers.get('Cookie') || '');
	let authCookie = cookies[AUTH_COOKIE_NAME];
	let didMakeCookie = false;
	let promise: Promise<Result>;
	if (authCookie) {
		promise = env.DB.prepare(
			`SELECT
				userhistory.productid,
				userhistory.lastvisited,
				products.name,
				products.picture,
				products.classification,
				products.lastupdated
			FROM userhistory
			INNER JOIN products USING (productid)
			WHERE cookie = ?2 AND NOT productid = ?1
			ORDER BY lastvisited DESC LIMIT ?3`
		)
			.bind(productId, authCookie, HISTORY_LIMIT)
			.all();
	} else {
		promise = new Promise((resolve) => {
			resolve({ success: true, results: [] });
		});
		didMakeCookie = true;
		authCookie = uuidv4();
	}

	updateHistory(productId, authCookie, env);

	return [promise, didMakeCookie ? authCookie : null];
}

interface Result {
	success: boolean;
	results?: HistoryCols[];
}

interface HistoryCols {
	productid: string;
	lastvisited: number;
	name: string;
	picture: string;
	classification: string;
	lastupdated: number;
}

async function updateHistory(productId: string, cookie: string, env: Env) {
	const { success } = await env.DB.prepare(
		`INSERT INTO userhistory VALUES (?1, ?2, ?3)
		ON CONFLICT(cookie, productid) DO UPDATE SET
			lastvisited = excluded.lastvisited`
	)
		.bind(cookie, productId, Date.now())
		.run();

	if (!success) throw new Error('Failed to add product to history');
}

async function handleClassification(product: ReqBody, env: Env, ctx: ExecutionContext): Promise<string> {
	const { success, results } = await env.DB.prepare('SELECT classification, lastupdated FROM products WHERE productid = ?1')
		.bind(product.id)
		.all();
	if (!success) throw new Error('Failed to check for product classification');
	const classResults = results as ProductCols[]; // Safe by Client API

	let classification: string;
	if (!classResults || classResults.length === 0) {
		// The picture has never been classified before.
		// classification = await classify(product, jimpPromise, env);
		classification = await classify(product, env);
	} else {
		const { classification: storedClass, lastupdated } = classResults[0];
		classification = storedClass;
		if (Date.now() - lastupdated >= UPDATE_THRESHOLD_MS) {
			// We classify the picture for next time, but don't wait for it to be classified this time.
			ctx.waitUntil(classify(product, env));
		}
	}

	return classification;
}

interface ProductCols {
	classification: string;
	lastupdated: number;
}

// const tempClassificationMap: { [id: string]: string } = {
// 	'1': 'clothing',
// 	'2': 'food',
// };
async function classify(product: ReqBody, env: Env): Promise<string> {
	const response = await fetch(product.pic);
	const data = await response.arrayBuffer();
	const input = await decodeImage(data);

	const tensorInput = new Tensor('float32', [1, 3, 224, 224], input);
	const output = await run(env.CLASSIFIER, MODEL_ID, tensorInput);
	const predictions = output.squeezenet0_flatten0_reshape0.value;
	const softmaxResult = softmax(predictions);
	const results = topClasses(softmaxResult, 5);
	const classification = results[0];

	const { success } = await env.DB.prepare(
		// ON CONFLICT is an SQLite feature and isn't standard.
		`INSERT INTO products VALUES (?1, ?2, ?3, ?4, ?5)
    	ON CONFLICT(productid) DO UPDATE SET
			name = excluded.name,
			picture = excluded.picture,
        	classification = excluded.classification,
        	lastupdated = excluded.lastupdated`
	)
		.bind(product.id, product.name, product.pic, classification.id, Date.now())
		.run();
	if (!success) throw new Error('Failed to register classification');

	return classification.id;
}

async function decodeImage(buffer: ArrayBuffer, width = 224, height = 224): Promise<any> {
	// eslint-disable-next-line no-async-promise-executor
	return new Promise(async (ok, err) => {
		// convert string to stream
		const stream: any = str(buffer as unknown as string);

		stream
			.pipe(
				new PNG({
					filterType: 4,
				})
			)
			.on('parsed', function (this: any) {
				if (this.width != width || this.height != height) {
					err({
						err: `expected width to be ${width}x${height}, given ${this.width}x${this.height}`,
					});
				} else {
					const [redArray, greenArray, blueArray]: number[][] = [[], [], []];

					for (let i = 0; i < this.data.length; i += 4) {
						redArray.push(this.data[i] / 255.0);
						greenArray.push(this.data[i + 1] / 255.0);
						blueArray.push(this.data[i + 2] / 255.0);
						// skip data[i + 3] to filter out the alpha channel
					}

					const transposedData = redArray.concat(greenArray).concat(blueArray);
					ok(transposedData);
				}
			})
			.on('error', function (error: any) {
				err({ err: error.toString() });
			});
	});
}

// Refer to https://en.wikipedia.org/wiki/Softmax_function
// Transforms values to between 0 and 1
// The sum of all outputs generated by softmax is 1.
function softmax(resultArray: number[]): any {
	const largestNumber = Math.max(...resultArray);
	const sumOfExp = resultArray
		.map((resultItem) => Math.exp(resultItem - largestNumber))
		.reduce((prevNumber, currentNumber) => prevNumber + currentNumber);
	return resultArray.map((resultValue) => {
		return Math.exp(resultValue - largestNumber) / sumOfExp;
	});
}

/* Get the top n classes from ImagetNet */

export function topClasses(classProbabilities: any, n = 5) {
	const probabilities = ArrayBuffer.isView(classProbabilities) ? Array.prototype.slice.call(classProbabilities) : classProbabilities;

	const sorted = probabilities
		.map((prob: any, index: number) => [prob, index])
		.sort((a: Array<number>, b: Array<number>) => {
			return a[0] == b[0] ? 0 : a[0] > b[0] ? -1 : 1;
		});

	const top = sorted.slice(0, n).map((probIndex: Array<number>) => {
		const iClass = imagenetClasses[probIndex[1]];
		return {
			id: iClass[0],
			index: parseInt(probIndex[1].toString(), 10),
			name: iClass[1].replace(/_/g, ' '),
			probability: probIndex[0],
		};
	});

	return top;
}

async function fetchSimilar(classification: string, env: Env, productId: string | null = null): Promise<string[][]> {
	let ready;
	if (productId === null) {
		ready = env.DB.prepare('SELECT productid, name, picture FROM products WHERE classification = ?1').bind(classification);
	} else {
		ready = env.DB.prepare('SELECT productid, name, picture FROM products WHERE classification = ?1 AND NOT productid = ?2').bind(
			classification,
			productId
		);
	}
	const { success: sameSuccess, results: sameResults } = await ready.all();

	if (!sameSuccess) throw new Error('Failed to find similar products');
	const productIdObjs = sameResults as { productid: string; name: string; picture: string }[]; // Safe
	return productIdObjs.map(({ productid, name, picture }) => [productid, name, picture]);
}

function calcClassToWeight(curClass: string, historyResults: HistoryCols[]) {
	const classToWeight: Record<string, number> = {};

	let total = 0;
	for (const [i, classification] of [curClass] // We give the current product's class a big boost, i.e. 'more like this'.
		// The current product should get shift to the front.
		.concat(historyResults.map(({ classification }) => classification))
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
	}

	return classToWeight;
}

async function cbf(
	classToWeight: Record<string, number>,
	similarPromise: Promise<string[][]>,
	curClass: string,
	env: Env
): Promise<string[][]> {
	const weightedProducts = (await Promise.all(
		Object.entries(classToWeight).map(([classification, weight]) =>
			(classification === curClass ? similarPromise : fetchSimilar(classification, env)).then((products) => [products, weight])
		)
	)) as [string[][], number][];

	if (weightedProducts[0][0].length === 0) {
		removeFromWeighted(weightedProducts, 0);
	}

	const similar = [];
	const upper = Math.min(
		NUM_RECOMMENDATIONS,
		weightedProducts.reduce((count, [products]) => count + products.length, 0) // Number of products
	);
	for (let itn = 0; itn < upper; itn++) {
		let bar = 0;
		infLoop: for (;;) {
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
				break infLoop;
			}
		}
	}

	return similar;
}

function removeFromWeighted(weightedProducts: [string[][], number][], idx: number) {
	const weight = weightedProducts[idx][1];
	weightedProducts.splice(idx, 1);
	for (const [i, [, otherWeight]] of weightedProducts.entries()) {
		// We set the total area to 1 again.
		weightedProducts[i][1] = otherWeight / (1 - weight);
	}
}
