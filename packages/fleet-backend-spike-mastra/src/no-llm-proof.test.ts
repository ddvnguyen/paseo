/**
 * B2 spike: no-LLM working-memory proof.
 *
 * Uses thread-scoped working memory in schema mode (blocks: handoff,
 * working_notes, conventions, open_questions) over an embedded-Turso file
 * (no remote server, no auth token). No model, no Agent, no embedder.
 *
 * Mapping under evaluation: resourceId = seat:<team>/<seat>,
 * threadId = room thread.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { Memory } from "@mastra/memory";
import { TursoStore } from "@mastra/turso";

const wmSchema = z.object({
  handoff: z.string().optional(),
  working_notes: z.string().optional(),
  conventions: z.string().optional(),
  open_questions: z.string().optional(),
});

function makeMemory(store: TursoStore): Memory {
  return new Memory({
    storage: store,
    options: {
      workingMemory: { enabled: true, scope: "thread", schema: wmSchema },
    },
  });
}

describe("mastra memory no-LLM working-memory proof", () => {
  let dir = "";
  let dbPath = "";
  let store: TursoStore | null = null;
  let memory: Memory | null = null;

  const resourceId = "seat:alpha/builder";
  const threadId = "room-thread-1";

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "mastra-spike-"));
    dbPath = join(dir, "spike.db");
    store = new TursoStore({ id: "spike-store", path: dbPath });
    await store.init();
    memory = makeMemory(store);
    await memory.createThread({ threadId, resourceId, title: "room thread" });
  });

  afterEach(async () => {
    if (store) await store.close();
    store = null;
    memory = null;
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes then reads working memory with zero LLM involvement", async () => {
    const payload = JSON.stringify({
      handoff: "builder owns open_questions",
      working_notes: "spike in progress",
      conventions: "single writer per block",
      open_questions: "none yet",
    });
    await memory!.updateWorkingMemory({ threadId, workingMemory: payload });
    const read = await memory!.getWorkingMemory({ threadId });
    expect(read).not.toBeNull();
    expect(JSON.parse(read!)).toEqual(JSON.parse(payload));
  });

  it("partial rewrite replaces the stored blob (merge happens in the tool layer, not storage)", async () => {
    await memory!.updateWorkingMemory({
      threadId,
      workingMemory: JSON.stringify({
        handoff: "first",
        working_notes: "notes-1",
        conventions: "c1",
        open_questions: "q1",
      }),
    });
    // updateWorkingMemory is a full replace at the storage layer: a partial
    // payload drops the sibling blocks unless the caller merges first.
    await memory!.updateWorkingMemory({
      threadId,
      workingMemory: JSON.stringify({ working_notes: "notes-2" }),
    });
    const read = await memory!.getWorkingMemory({ threadId });
    expect(JSON.parse(read!)).toEqual({ working_notes: "notes-2" });
  });

  it("a writer can clobber a sibling block: no per-field authority in Mastra", async () => {
    await memory!.updateWorkingMemory({
      threadId,
      workingMemory: JSON.stringify({
        handoff: "owner: builder",
        working_notes: "n",
        conventions: "c",
        open_questions: "q",
      }),
    });
    await memory!.updateWorkingMemory({
      threadId,
      workingMemory: JSON.stringify({ handoff: "owner: rival-writer" }),
    });
    const read = await memory!.getWorkingMemory({ threadId });
    expect(JSON.parse(read!).handoff).toBe("owner: rival-writer");
  });
});
