import type { Action } from 'svelte/action';

/**
 * Show a full-screen overlay from inside a card. A `backdrop-filter` or
 * `transform` on any ancestor turns `position: fixed` into "fixed to that
 * ancestor", and its stacking context caps the overlay's z-index, so the node
 * moves to the end of the body. Use it on the one root element of a block.
 */
export const portal: Action<HTMLElement> = (node) => {
	document.body.appendChild(node);
	return {
		destroy() {
			node.remove();
		}
	};
};
