import { AnthropicFileBackend } from "./anthropic-file.js";

/**
 * Backend for the JSONL mirror file maintained by remote-memory MCP under
 * its LOCAL_MIRROR_PATH mode (Strategy E, see 04-TASKS-V2.md §2.7).
 *
 * Wire-compatible with the official anthropic memory JSONL format. Data plane
 * IO is delegated to AnthropicFileBackend; only the BackendInfo identity
 * differs. This keeps the two backends from drifting at the data layer.
 *
 * GitHub sync (push/pull) is intentionally NOT exposed here (D3). The LLM
 * calls remote-memory's own sync_push/sync_pull tools directly; graph-view's
 * mirror polling then picks up the file change automatically.
 */
export class RemoteMemoryMirrorBackend extends AnthropicFileBackend {
  constructor(mirrorPath: string) {
    super(mirrorPath, "remote-memory-mirror");
  }
}
