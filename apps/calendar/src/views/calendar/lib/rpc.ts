/**
 * Electroview RPC singleton for the calendar webview.
 *
 * IMPORTANT: Both steps are required:
 * 1. Electroview.defineRPC() creates the typed schema object.
 * 2. new Electroview({ rpc }) wires up the WebSocket transport.
 * Without step 2, all rpc.request.* calls throw "missing send method".
 */

import { Electroview } from "electrobun/view";

export const rpc = Electroview.defineRPC({
	maxRequestTime: Infinity,
	handlers: {
		requests: {},
	},
});

new Electroview({ rpc });
