/**
 * Electroview RPC singleton.
 *
 * Electroview.defineRPC creates the typed schema object.
 * new Electroview({ rpc }) wires up the WebSocket transport.
 * Both steps are required for RPC to work.
 */

import { Electroview } from "electrobun/view";

export const rpc = Electroview.defineRPC({
	maxRequestTime: Infinity,
	handlers: {
		requests: {},
	},
});

// Wire up WebSocket transport — must be called once at startup.
new Electroview({ rpc });
