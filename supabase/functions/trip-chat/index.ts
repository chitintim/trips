// Trip Chat edge function. The request handler lives in handler.ts (testable);
// see that file and scratchpad/trip-chat-stream-contract.md for the protocol.
import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { handleChat } from './handler.ts'

Deno.serve((req) => handleChat(req))
