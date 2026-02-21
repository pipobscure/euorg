/**
 * Electroview RPC singleton.
 *
 * Electroview.defineRPC creates the typed RPC schema object.
 * new Electroview({ rpc }) wires up the WebSocket transport to the Bun process.
 * Both steps are required for RPC to work.
 *
 * Message listeners (syncProgress, syncComplete, contactChanged) are registered
 * via rpc.addMessageListener() in App.svelte rather than as inline handlers here.
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
