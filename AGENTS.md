# Agent workflow

Optimize token usage by matching the model and scope to the task.

- Use `gpt-6-astra` for substantial planning, architecture decisions, and difficult reasoning.
- Use `gpt-5.6-sol` as the default worker for implementation, debugging, tests, and routine reviews.
- Subagents are authorized. Choose their model according to difficulty: use Sol for bounded work, and Astra when complexity or unresolved uncertainty warrants it. A lighter model may handle simple, well-defined tasks when it reduces total cost.
- Handle trivial edits directly; do not spawn agents or add a planning phase solely to follow these defaults.
- Delegate only concrete, independent subtasks while the parent continues useful work. Avoid duplicate investigations and overlapping file edits.
- Give workers a concise plan, relevant paths, constraints, and acceptance criteria. Prefer targeted context over copying the entire conversation.
- When specifying a subagent model override, use `fork_turns: "none"` with a self-contained brief, or a small positive turn count when recent context is needed; do not combine overrides with `fork_turns: "all"`.
- Reuse existing findings and run checks appropriate to the change. Escalate to Astra when Sol encounters a substantive reasoning blocker rather than repeating unproductive attempts.

These are model-selection defaults for sessions and delegated tasks. This file does not change the model of an already running agent; apply them through the available model-selection controls.
