// Single-process test entry so the tsx loader stays active (node --test spawns per-file
// children that don't inherit --import). node:test auto-runs registered tests on exit.
import "./loader-contracts.test.js";
import "./invalid-status.test.js";
import "./fix-loop.test.js";
import "./approval.test.js";
import "./postactions-resume.test.js";
import "./executors.test.js";
import "./preflight-consistency.test.js";
import "./task-metadata.test.js";
import "./m1-reviewability.test.js";
import "./skipped-visibility.test.js";
import "./gitscope.test.js";
import "./diff-scope-injection.test.js";
import "./verify-local.test.js";
import "./prompt-assembly.test.js";
import "./measurement-completeness.test.js";
import "./session-ref.test.js";
import "./codex-executor.test.js";
import "./codex-integration.test.js";
