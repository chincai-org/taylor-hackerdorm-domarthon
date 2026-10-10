/**
 * LEVER: `loop` — the control flow of one solve call, and how the reply is parsed.
 *
 * V1 makes exactly ONE model call. It does not run the tests, it does not check
 * its own answer and it does not reflect. It takes the FIRST fenced block of the
 * reply. Taking the last one is already a change worth measuring, because a model
 * that explains itself first puts the real answer in the last block.
 *
 * Things a later node might try here:
 *   - take the LAST fenced block instead of the first (motif: last-fence-not-first)
 *   - prefer a block whose language tag is js or javascript
 *   - draw two drafts and keep the longer one (motif: best-of-two)
 *   - raise or lower MAX_OUTPUT_TOKENS, which is the `decoding` lever next door
 *   - call the `recovery` seam for `no-code-block` as well as `empty-file`
 *
 * V1 does NOT catch BudgetExceededError. The runner catches it and scores that
 * task 0. Catching it is a `recovery` change and the tree can measure whether it
 * helps. Every model call needs a distinct label; V1 uses exactly one, "draft".
 */
import type { TaskView, HarnessContext, Solution, SourceFile } from './contract.js';
import { selectContext } from './retrieval.js';
import { buildSystemPrompt, buildUserPrompt } from './prompt.js';
import { attemptRepair, type Failure } from './recovery.js';

export const MAX_OUTPUT_TOKENS = 4096;

/** V1 takes the FIRST fenced block. Taking the last one is already a change. */
export function extractSolutionFiles(task: TaskView, replyText: string): SourceFile[] {
  const fence = /```[a-zA-Z0-9_-]*\n([\s\S]*?)```/g;
  const blocks: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = fence.exec(replyText)) !== null) blocks.push(m[1] ?? '');
  const code = blocks.length > 0 ? blocks[0]! : replyText;
  return [{ path: task.entryFile, contents: `${code.trim()}\n` }];
}

/** V1 makes exactly one model call. */
export async function runLoop(task: TaskView, ctx: HarnessContext): Promise<Solution> {
  const context = selectContext(task);
  ctx.log.event('retrieval', { files: context.files.length, dropped: context.droppedFiles.length });

  const reply = await ctx.model.complete({
    label: 'draft',
    system: buildSystemPrompt(),
    messages: [{ role: 'user', content: buildUserPrompt(task, context) }],
    maxTokens: MAX_OUTPUT_TOKENS,
    temperature: 0,
  });
  ctx.log.event('model', {
    label: 'draft', stopReason: reply.stopReason, outputTokens: reply.outputTokens,
  });

  const files = extractSolutionFiles(task, reply.text);
  if (files[0]!.contents.trim().length === 0) {
    const failure: Failure = { kind: 'empty-file', detail: 'the model returned no code' };
    const repaired = await attemptRepair(task, ctx, failure, reply.text);
    if (repaired !== null) return repaired;
    ctx.log.event('give-up', { reason: failure.kind });
    return { files: [{ path: task.entryFile, contents: '' }], notes: 'no code produced' };
  }
  return { files, notes: 'single-shot draft' };
}
