/* eslint-disable @typescript-eslint/no-explicit-any */
import { v4 as uuidv4 } from 'uuid';
import { parse } from 'cookie';
// @ts-expect-error: Constellation is currently untyped.
import { Tensor, run } from '@cloudflare/constellation';
import { imagenetClasses } from './imagenet';
// @ts-expect-error: pngjs/browser's types don't work.
import { PNG } from 'pngjs/browser';
import str from 'string-to-stream';
import { h64 } from 'xxhashjs';
import { MaxHeap } from '@datastructures-js/heap';

const UPDATE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1_000;
const AUTH_COOKIE_MAX_AGE_S = 86_400 * 365;
const AUTH_COOKIE_NAME = 'id-cookie';
const HISTORY_MAX_AGE_MS = 27 * 24 * 60 * 60 * 1_000;
const HISTORY_LAMBDA = 0.1;
const HISTORY_LIMIT = 40;
const NUM_CB_RECOMMENDATIONS = 3;
const NUM_COLLAB_RECOMMENDATIONS = 3;
const MODEL_ID = 'cdfb1bfb-37b2-4678-84b8-f05cc695d780';
const NUM_HASHES = 200; // for MinHashes
const MIN_HH_SIZE = 2; // for hashes of multiple MinHashes
const COLLAB_ADDITIONS_CAP = 40;

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const reqBody = await parseRequest(request);
		const cookie = parse(request.headers.get('Cookie') || '')[AUTH_COOKIE_NAME];
		const [historyPromise, newCookie] = await handleHistory(cookie, reqBody.id, env);
		const productClass = await handleClassification(reqBody, env, ctx);
		const similarPromise = fetchSimilar(productClass, env, reqBody.id);

		const { success: historySuccess, results: historyResults } = await historyPromise;
		// Maybe we should handle this earlier to save on redundant HTTP requests.
		if (!historySuccess) throw new Error('Failed to get user history');

		const classToWeight = calcClassToWeight(productClass, historyResults as HistoryCols[] /* safe */);
		const similarCollabPromises = await collabFiltering((cookie ? cookie : newCookie) as string, reqBody.id, env);
		const similarCb = await cbFiltering(
			classToWeight,
			similarPromise,
			productClass,
			NUM_CB_RECOMMENDATIONS + NUM_COLLAB_RECOMMENDATIONS - similarCollabPromises.length,
			env
		);

		const similarCollab = await Promise.all(similarCollabPromises);
		const similar = similarCb.concat(similarCollab);
		shuffle(similar);
		let recommendations = `<ul class="list-group list-group-horizontal">\n`;
		for (const product of similar) {
			recommendations += `<a class="list-group-item" href="/products/${product[0]}">
	${product[1]}
	<span class="pull-left ">
        <img src="${product[2]}" class="img-reponsive img-rounded" style="width:100px; height:100px;" />
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
	if (pathname !== '/api/recommendations') throw new Error('Unrecognised pathname');
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

async function handleHistory(cookie: string | undefined, productId: string, env: Env): Promise<[Promise<Result>, string | null]> {
	let didMakeCookie = false;
	let promise: Promise<Result>;
	if (cookie) {
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
			.bind(productId, cookie, HISTORY_LIMIT)
			.all() as unknown as Promise<Result>;
	} else {
		promise = new Promise((resolve) => {
			resolve({ success: true, results: [] });
		});
		didMakeCookie = true;
		cookie = uuidv4();
	}

	updateHistory(productId, cookie, env);

	return [promise, didMakeCookie ? cookie : null];
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
	const classResults = results as unknown as ProductCols[]; // Safe by Client API

	let classification: string;
	if (!classResults || classResults.length === 0) {
		// The picture has never been classified before.
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
	const productIdObjs = sameResults as unknown as { productid: string; name: string; picture: string }[]; // Safe
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

async function cbFiltering(
	classToWeight: Record<string, number>,
	similarPromise: Promise<string[][]>,
	curClass: string,
	amount: number,
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
		amount,
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

async function collabFiltering(ownCookie: string, curProduct: string, env: Env): Promise<Promise<string[]>[]> {
	const { success, results } = await env.DB.prepare('SELECT productid, lastvisited FROM userhistory WHERE cookie = ?1')
		.bind(ownCookie)
		.all();
	if (!success) throw new Error('Failed to fetch userhistory');
	if ((results as unknown as OwnHistoryCols[]).length === 0) return [];
	const products = (results as unknown as OwnHistoryCols[]).reduce((set, cols) => {
		if (Date.now() - cols.lastvisited <= HISTORY_MAX_AGE_MS) {
			set.add(cols.productid);
		}
		return set;
	}, new Set<string>());

	// likelihood of user being potential candidate = kNUM_HASHES / MIN_HH_SIZE**2
	const ownHashes = minHashes(products);
	const hhs = [];
	const limit = Math.floor(Math.min(NUM_HASHES, ownHashes.size()) / MIN_HH_SIZE);
	for (let i = 0; i < limit; i++) {
		let hh = 0;
		for (let j = 0; j < MIN_HH_SIZE; j++) {
			hh ^= ownHashes.pop() as number;
		}
		hhs.push(hh);
	}

	// Update own minhhs
	const prepareDelMinhhusers = env.DB.prepare(
		`DELETE FROM minhhusers
		WHERE (
			minhh IN
			(SELECT minhh FROM userminhhs WHERE cookie = ?1)
		)
		AND usercookie = ?1`
	).bind(ownCookie);
	const prepareDelUserminhhs = env.DB.prepare(
		`DELETE FROM userminhhs
		WHERE cookie = ?1`
	).bind(ownCookie);
	const preparedInsToMinhhusers = env.DB.prepare(`INSERT INTO minhhusers(minhh, usercookie) VALUES(?2, ?1)`);
	const preparedInsToUserMinhhs = env.DB.prepare(`INSERT OR IGNORE INTO userminhhs(cookie, minhh) VALUES(?1, ?2)`);
	await env.DB.batch(
		[
			prepareDelMinhhusers,
			prepareDelUserminhhs,
			hhs.map((hh) => [preparedInsToUserMinhhs.bind(ownCookie, hh), preparedInsToMinhhusers.bind(ownCookie, hh)]),
		].flat(2)
	);

	const { success: hhSuccess, results: hhResults } = await env.DB.prepare(
		`SELECT usercookie FROM minhhusers WHERE minhh IN (?1) AND NOT usercookie = ?2`
	)
		.bind(hhs.join(', '), ownCookie)
		.all();
	if (!hhSuccess) throw new Error('Failed to fetch similar users');
	const collectedUsers = hhResults as unknown as UserCookieCol[];
	const userToFreq: Record<string, number> = {};
	for (const { usercookie } of collectedUsers) {
		userToFreq[usercookie] = (userToFreq[usercookie] || 0) + 1;
	}
	const similarUsers = new MaxHeap<[string, number]>((userData) => userData[1]);
	for (const [user, freq] of Object.entries(userToFreq)) {
		similarUsers.push([user, freq]);
	}

	// This method of bucketing doesn't statistically imply how similar each user is in a linear fashion.
	// Perhaps look into the actual relationship later.
	const similarUserList = [];
	for (let i = 0; i < Math.min(COLLAB_ADDITIONS_CAP, similarUsers.size()); i++) {
		const [cookie] = similarUsers.pop() as [string, number];
		similarUserList.push(cookie);
	}
	const { success: hisSuccess, results: hisResults } = await env.DB.prepare(
		'SELECT cookie, productid, lastvisited FROM userhistory WHERE cookie IN (?1)'
	)
		.bind(similarUserList.join(', '))
		.all();
	if (!hisSuccess) throw new Error("Failed to get similar users' histories");
	const productToWeight: Record<string, number> = {};
	let total = 0;
	for (const { productid, lastvisited } of hisResults as unknown as SimilarHistoryCols[]) {
		if (Date.now() - lastvisited > HISTORY_MAX_AGE_MS) continue;
		productToWeight[productid] = (productToWeight[productid] || 0) + 1;
		total += 1;
	}

	let size = 0;
	for (const key of Object.keys(productToWeight)) {
		size++;
		productToWeight[key] = productToWeight[key] / total;
	}

	const similar = [];
	const upper = Math.min(NUM_COLLAB_RECOMMENDATIONS, size);
	for (let itn = 0; itn < upper; itn++) {
		let bar = 0;
		infLoop: for (;;) {
			const rand = Math.random();
			let i = 0;
			for (const [product, weight] of Object.entries(productToWeight)) {
				if (rand - bar > weight && i !== productToWeight.length - 1 /* in case of floating point weirdness */) {
					bar += weight;
					i++;
					continue;
				}

				similar.push(
					(async () => {
						const { success, results } = await env.DB.prepare('SELECT productid, name, picture FROM products WHERE productid = ?1')
							.bind(product)
							.all();
						if (!success) {
							return ['0', '', ''];
						}
						const tResults = results as unknown as Record<string, string>[];
						return [tResults[0].productid, tResults[0].name, tResults[0].picture];
					})()
				);

				delete productToWeight[product];
				break infLoop;
			}
		}
	}

	return similar;
}

interface SimilarHistoryCols {
	cookie: string;
	productid: string;
	lastvisited: number;
}

interface UserCookieCol {
	usercookie: string;
}

interface OwnHistoryCols {
	productid: string;
	lastvisited: number;
}

// https://cs.brown.edu/courses/cs253/papers/nearduplicate.pdf
// http://web.eecs.utk.edu/~jplank/plank/classes/cs494/494/notes/Min-Hash/index.html
// MinHash with one hash function.
function minHashes(elements: Set<string>): MaxHeap<number> {
	const hashes = new MaxHeap<number>();
	const seen = new Set();
	for (const element of elements) {
		const hash = h64(element, 0xabcd).toNumber();
		if (seen.has(hash)) continue;
		seen.add(hash);

		if (hashes.size() < NUM_HASHES) {
			hashes.push(hash);
		} else if (hash > (hashes.top() as number)) {
			hashes.push(hash);
			if (hashes.size() > NUM_HASHES) {
				hashes.pop();
			}
		}
	}

	return hashes;
}

// https://stackoverflow.com/questions/2450954/how-to-randomize-shuffle-a-javascript-array
function shuffle<T>(array: T[]) {
	for (let i = array.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[array[i], array[j]] = [array[j], array[i]];
	}
}
