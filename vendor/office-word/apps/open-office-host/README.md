# Open Office OfficeWord host

This locally compiled WASM module embeds the real `WordApp` on one egui canvas. It keeps up to eight independent `WordApp` sessions; document parsing, commands, undo, layout and DOCX/PDF serialization are OfficeWord code. Vue owns tabs, file pickers and durable save acknowledgements.

`createHost(callback)` returns a host. The callback receives a JSON string with `type: "change" | "action" | "error"`. Action events identify their `sessionId`, `documentId`, `revision` and `selection`.

- `prepare(id, name, bytes)` parses a new session without activating it; empty bytes create a blank document. Duplicate IDs and imports larger than 64 MiB are rejected.
- `start(canvas)` starts one shared WebRunner. `activate(id)` selects an existing session.
- `inspect(id)` returns JSON including content revision, dirty/undo/redo state, selection, formatting, text, page count and the upstream UI geometry.
- `command(id, commandId, paramsJson)` runs an upstream command and returns JSON `{ok,result?,error?,snapshot}`. File lifecycle commands are delegated to Vue. Filesystem-path parameters, macros and Repeat are unavailable through this bridge. Paragraph path arrays remain valid.
- `host.deliverPicture` / `host.cancelPicture` are picker-completion adapters for WordApp's existing insert-or-change-picture flow. They do not implement a replacement image engine.
- `host.mcp.commands` discovers document commands from the live registry, with parameter documentation, contextual availability, search and pagination. `host.mcp.query` only accepts read-only structure/format queries; `host.mcp.execute` accepts a document command and explicit parameters, sharing the editor's document, layout and undo history. UI and application commands, macros, filesystem paths and system clipboard access are excluded. Missing parameters cannot open a dialog: interactive engine requests are rejected and their edit/undo changes rolled back before the UI consumes them.
- `flush(id)` resolves after the current session's next UI pass; nonactive sessions have no queued input and resolve immediately.
- `exportFile(id,"docx"|"pdf")` synchronously returns bytes and does not change the saved baseline. Calling `inspect` immediately afterwards, with no intervening await, yields that export's content revision.
- `markSaved(id,documentId,revision)` acknowledges a successful durable DOCX save only when both receipt fields still match. PDF export never acknowledges a DOCX save.
- `discardChanges(id,documentId,revision)` restores the last acknowledged baseline; it is not a read-only receipt check.
- `close(id,documentId,revision,force)` removes a matching session, refusing dirty documents unless the user explicitly agreed to discard them.
- `setActive(false)` suppresses new ordinary input and retains IME events in the host input filter; this alone does not guarantee a commit after the canvas loses focus. The shell must complete composition and flush before deactivation, or refuse the transaction while keeping the document. `destroy()` releases eframe's listeners, graphics resources and all sessions.

Before exporting, replacing, switching or closing the active tab, the shell must blur the text agent, wait for an existing composition to finish, and await `flush`. An outstanding flush prevents changing the active session. Merely disabling the canvas is not a substitute for this transaction: eframe owns a browser input queue that is consumed on the next frame.

Dirty state compares the complete OfficeWord document with the saved baseline. Revisions increase only when document content changes, including changes outside the normal command path. Undoing to the saved content becomes clean without rolling back the revision. CAS arguments are compared as exact numbers, so fractional/nonfinite JavaScript receipts are rejected.

The embedding adds an optional `Services.host_command` hook before command dialogs or mutation, exposes the existing image-picker completion method, and records acknowledged host saves for the title without inventing filesystem paths. The optional `browser_clipboard` mode waits for DOM Copy/Cut/Paste events instead of executing their keydowns twice; Ctrl+Shift+V pastes plain text. Menu and explicit clipboard commands remain available. These host adaptations leave the default standalone behavior unchanged.

The input adapter also handles egui's `DeleteSurrounding` event in Unicode scalar values. An immediately following Text/Commit replacement is applied in one engine transaction, including rollback and undo. Paragraph separators count as one character; counts stop at the edge of a contiguous paragraph container. Selections across table/story boundaries and equation/column selections are explicitly rejected. This corrects the shared text input protocol rather than altering the browser input value or caret.
