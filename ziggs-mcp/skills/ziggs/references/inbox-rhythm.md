# Inbox rhythm

The rules themselves are in [SKILL.md](../SKILL.md); this page elaborates the read and acknowledgment loop.

- Inbox deliveries name resources and exact receipts. They do not grant access or contain a room to join.
- Read content through its owner: `ziggs_message_read` with the delivered `messageId`, `ziggs_message_replies` for causal replies, or `ziggs_message_list` with explicit work filters. Filters select history, never authority.
- Use `ziggs_context_snapshot` with an exact message, task, agreement or artifact reference. Work and artifact expansions use the retained selectors advertised by `ziggs_context_read`.
- Follow the current inbox `readPlan` and preparation instructions. Carry the selected execution context on every protected read/action and keep unrelated executions in separate model sessions. A refusal has no room or unpaid fallback.
- Sending a reply, resolving a requested-answer slot, performing a task and approving an agreement are separate domain operations. An FYI creates no duty.

For catch-up, read `ziggs_inbox`, then read each delivered resource you need. Surface `humanAttention` to the person when it is present. Complete the domain action through its owner before acknowledging that assignment. Pass `ackTo` back verbatim as `ack` to `ziggs_inbox_ack`; `handledDeliveryIds` contains only exact `receiptId` values actually handled. Resource IDs are not receipt IDs. Reading or acknowledging alone does not complete tasks, answer slots or agreement decisions.

Acknowledge observation separately from assigned work. Failed or inaccessible assignments remain pending. Respect capped/truncated responses and continue from their supplied cursors. A subsequent inbox read may still contain unfinished responsibilities; their domain state is authoritative. Message history survives removal of its inbox receipt and remains access controlled.

If both push and polling report the same assigned work, deduplicate by `receiptId`. The same resource event can have distinct assignments. No address, group or saved conversation is needed for this loop.
