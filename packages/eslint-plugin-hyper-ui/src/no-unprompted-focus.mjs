import { createTextRule, maskCode } from './rule-helpers.mjs';

export { noUnpromptedFocus };

const FOCUS_CALL = /\.\s*focus\s*\(/gu;
const UNPROMPTED_CALL =
	/(?<![\w$])(?:\$effect(?:\.pre)?|onMount|setTimeout|queueMicrotask|requestAnimationFrame|tick\s*\(\s*\)\s*\.\s*then)\s*\(/gu;
const ASYNC_FUNCTION =
	/(?<![\w$.])async(?:\s+function\b\s*\*?\s*(?<declared>[\w$]*)\s*\(|\s+(?<method>[\w$]+)\s*\(|\s+[\w$]+\s*(?<param>=>)|\s*(?<arrow>\())/gu;
const ASSIGNED_NAME = /(?<![\w$])(?<name>[\w$]+)\s*(?::[^=;{}()]*)?(?:=\s*\{?|:)\s*$/u;
const OPENERS = '{([';
const CLOSERS = '})]';

/**
 * @param {string} code
 * @param {number} from
 * @param {(char: string, depth: number) => boolean} stop
 * @returns {number}
 */
const scan = (code, from, stop) => {
	let depth = 0;
	for (let index = from; index < code.length; index += 1) {
		const char = code[index] ?? '';
		if (OPENERS.includes(char)) depth += 1;
		if (CLOSERS.includes(char)) depth -= 1;
		if (stop(char, depth)) return index;
	}
	return code.length;
};

/**
 * @param {string} code
 * @param {number} open
 */
const closingOf = (code, open) =>
	scan(code, open, (char, depth) => depth === 0 && CLOSERS.includes(char));

/**
 * @param {string} code
 * @param {number} from
 */
const expressionEnd = (code, from) =>
	scan(code, from, (char, depth) => depth < 0 || (depth === 0 && (char === ',' || char === ';')));

/**
 * @param {string} code
 * @param {number} arrow
 * @returns {[number, number]}
 */
const arrowBody = (code, arrow) => {
	const start = code.slice(arrow + 2).search(/\S/u) + arrow + 2;
	return code[start] === '{'
		? [start, closingOf(code, start)]
		: [start, expressionEnd(code, start)];
};

/**
 * @param {string} code
 * @param {RegExpExecArray} match
 * @returns {[number, number] | null}
 */
const asyncBody = (code, match) => {
	const end = match.index + match[0].length;
	const groups = match.groups ?? {};
	const before = code.slice(Math.max(0, match.index - 200), match.index);
	const name = groups.declared || groups.method || ASSIGNED_NAME.exec(before)?.groups?.name;
	if (name?.startsWith('on')) return null;
	if (groups.param) return arrowBody(code, end - 2);
	const params = closingOf(code, end - 1);
	const arrow = code.indexOf('=>', params);
	if (groups.arrow) return arrow === -1 ? null : arrowBody(code, arrow);
	const body = code.indexOf('{', params);
	return body === -1 ? null : [body, closingOf(code, body)];
};

/**
 * @param {string} code
 * @returns {Array<[number, number]>}
 */
const unpromptedRegions = (code) => [
	...Array.from(code.matchAll(UNPROMPTED_CALL), (match) => {
		const open = match.index + match[0].length - 1;
		return /** @type {[number, number]} */ ([open, closingOf(code, open)]);
	}),
	...Array.from(code.matchAll(ASYNC_FUNCTION), (match) => asyncBody(code, match)).filter(
		(region) => region !== null,
	),
];

const noUnpromptedFocus = createTextRule({
	description:
		'Require focus that runs without a user action to go through claimFocus or focusFromUser.',
	messageId: 'unpromptedFocus',
	message:
		'This focus runs without a user action, so it can take focus from the field the user types in. Use claimFocus from $hyper-ui/overlay for focus nobody asked for, or focusFromUser for focus that follows a click or a key.',
	findMatches(source) {
		const code = maskCode(source);
		const regions = unpromptedRegions(code);
		return Array.from(code.matchAll(FOCUS_CALL), (match) => match.index).filter((index) =>
			regions.some(([start, end]) => start < index && index < end),
		);
	},
});
