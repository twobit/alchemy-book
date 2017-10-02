import * as CodeMirror from "codemirror";

import {
    Crdt,
    LocalChange,
    RemoteChange,
    updateAndConvertLocalToRemote,
    updateAndConvertRemoteToLocal
} from "./crdt";
import { LinearCrdt } from "./crdt_linear"
import { EditorSocket, UserPresence } from "./editor_socket";
import History from "./history";
import RemoteCursor from "./remote_cursor";

const IgnoreRemote = "ignore_remote";
const UndoRedo = "undo_redo";
const Initialize = "setValue";

const MAX_CHAR_COUNT = 2500;

export default class Editor {
    protected codemirror: CodeMirror.Editor;
    protected crdt: Crdt;
    protected editorSocket: EditorSocket;
    protected history: History;
    protected lamport: number;
    protected site: number;
    protected exceededLimit: boolean;

    // This stores the previous cursor position in order to know if the cursor
    // has actually moved when cursorActivity gets triggered. We are only
    // interested in cursor movements that are not due to edits, so edits
    // will update `previousCursorPosition` before the cursor callback gets
    // triggered.
    protected previousCursorPosition: CodeMirror.Position;

    // Map user_id -> site_id -> cursor element
    // Since the same user could have the same document open on multiple tabs,
    // thus have multiple sites.
    protected cursorWidgets: Map<number, Map<number, RemoteCursor>>;

    constructor(domNode: HTMLTextAreaElement,
                editorSocket: EditorSocket,
                private limitCallback: (exceeded: boolean) => void) {
        this.codemirror = CodeMirror.fromTextArea(domNode, {
            lineNumbers: true,
            theme: "zenburn",
        });
        this.editorSocket = editorSocket;

        this.editorSocket.connect(this.onInit, this.onRemoteChange);
        this.codemirror.on("beforeChange", this.beforeChange);
        this.codemirror.on("change", this.onLocalChange);
        this.codemirror.on("cursorActivity", this.onLocalCursor);
        this.codemirror.on("keyup", this.onKeyUp as any)

        this.cursorWidgets = new Map();

        this.history = new History();

        this.exceededLimit = false;
    }

    // Note: this method is currently inefficient in that any one cursor
    // movement causes all others to be redraw. However, there should be
    // few cursors in total so this is probably not going to be a concern.
    public updateCursors(presences: UserPresence[]): void {
        const cursorsToDelete = this.allCursors();
        presences.forEach(presence => {
            // Don't draw a remote cursor for your own instance!
            if (presence.siteId !== this.site) {
                const cursor = this.getCursorFor(presence);
                cursor.moveTo(presence.cursor);

                cursorsToDelete.delete(cursor);
            }
        });

        // Remaining cursors are probably from old sessions, remove them
        cursorsToDelete.forEach(cursor => {
            cursor.detach();
            this.cursorWidgets.get(cursor.userId)!.delete(cursor.siteId);
        });
    }

    protected beforeChange = (editor: CodeMirror.Editor, change: CodeMirror.EditorChangeCancellable) => {
        if (change.origin === "undo" || change.origin === "redo") {
            // We use custom CRDT logic to handle undo/redo history, don't use CodeMirror's
            change.cancel();

            // This is just to prevent CodeMirror's history from taking up memory
            this.codemirror.getDoc().clearHistory();
        } else {
            let editorCharCount = 0;
            // The +1s are to count newline characters
            editor.getDoc().eachLine(line => {
                editorCharCount += line.text.length + 1
            });
            let delta = 0;
            if (change.text) {
                change.text.forEach(line => {
                    delta += line.length + 1
                });
            }
            if (change.removed) {
                change.removed.forEach(line => {
                    delta -= line.length + 1
                });
            }

            const exceededLimit = editorCharCount + delta > MAX_CHAR_COUNT;
            if (delta > 0 && exceededLimit && change.origin !== Initialize) {
                change.cancel();
            }
            if (exceededLimit !== this.exceededLimit) {
                this.limitCallback(exceededLimit);
            }
            this.exceededLimit = exceededLimit;
        }
    }

    protected onKeyUp = (editor: CodeMirror.Editor, e: KeyboardEvent) => {
        const hasModifier = e.ctrlKey || e.metaKey;
        if (hasModifier && !e.shiftKey && e.key.toLowerCase() === "z") {
            e.preventDefault();
            this.undo();
        }

        if ((hasModifier && !e.shiftKey && e.key.toLowerCase() === "y") ||
            (hasModifier && e.shiftKey && e.key.toLowerCase() === "z")) {
            e.preventDefault();
            this.redo();
        }
    }

    protected onLocalCursor = (editor: CodeMirror.Editor) => {
        this.editorSocket.sendCursor(editor.getDoc().getCursor());

        const currentPosition = this.codemirror.getDoc().getCursor();
        if (this.previousCursorPosition) {
            if (currentPosition.ch != this.previousCursorPosition.ch ||
                currentPosition.line != this.previousCursorPosition.line) {
                this.history.onCursorMove();
            }
        }
        this.previousCursorPosition = currentPosition;
    }

    protected onLocalChange = (editor: CodeMirror.Editor, change: CodeMirror.EditorChange) => {
        const isUserInput = ![IgnoreRemote, UndoRedo, Initialize].includes(change.origin)
        if (isUserInput) {
            this.lamport = this.lamport + 1;
            const changes = updateAndConvertLocalToRemote(this.crdt, this.lamport, this.site, change);
            this.history.onChanges(changes);
            changes.forEach(change => this.editorSocket.sendChange(change, this.lamport));
        }

        this.previousCursorPosition = this.codemirror.getDoc().getCursor();
    }

    protected onRemoteChange = ({change, lamport}) => {
        this.lamport = Math.max(this.lamport, lamport) + 1;
        this.convertRemoteToLocal(change);

        this.previousCursorPosition = this.codemirror.getDoc().getCursor();
    }

    protected onInit = (resp) => {
        this.crdt = new LinearCrdt();
        this.crdt.init(resp.state);
        this.site = resp.site;
        this.lamport = 0;
        this.codemirror.setValue(this.crdt.toString());
    }

    protected undo(): void {
        this.lamport = this.lamport + 1;
        this.applyUndoRedo(this.history.makeUndoChanges(this.lamport));
    }

    protected redo(): void {
        this.lamport = this.lamport + 1;
        this.applyUndoRedo(this.history.makeRedoChanges(this.lamport));
    }

    private applyUndoRedo(changes: RemoteChange.t[] | null): void {
        if (changes) {
            let lastChange: any = null;
            changes.forEach(change => {
                const localChange = this.convertRemoteToLocal(change);

                // Want to move the cursor to wherever text changed.
                if (localChange) {
                    lastChange = localChange;
                }

                this.editorSocket.sendChange(change, this.lamport);
            });

            if (lastChange) {
                if (lastChange.text === "") {
                    // Deletion: cursor should go where the text used be
                    this.codemirror.getDoc().setCursor(lastChange.from);
                } else {
                    // Insertion: cursor should go at the end of the text
                    this.codemirror.getDoc().setCursor({
                        line: lastChange.to.line,
                        ch: lastChange.to.ch + 1,
                    });
                }
            }
        }
    }

    private convertRemoteToLocal(change: RemoteChange.t): LocalChange.t | null {
        const localChange = updateAndConvertRemoteToLocal(this.crdt, change);
        if (localChange) {
            this.codemirror.getDoc().replaceRange(localChange.text,
                localChange.from, localChange.to, IgnoreRemote);
        }
        return localChange;
    }

    private getCursorFor(presence: UserPresence): RemoteCursor {
        let sites;
        if (this.cursorWidgets.has(presence.userId)) {
            sites = this.cursorWidgets.get(presence.userId);
        } else {
            sites = new Map();
            this.cursorWidgets.set(presence.userId, sites);
        }

        let cursor;
        if (sites.has(presence.siteId)) {
            cursor = sites.get(presence.siteId);
        } else {
            cursor = new RemoteCursor(presence.color,
                presence.userId, presence.siteId, this.codemirror);
            sites.set(presence.siteId, cursor);
        }

        return cursor;
    }

    private allCursors(): Set<RemoteCursor> {
        const cursors: Set<RemoteCursor> = new Set();
        this.cursorWidgets.forEach(sites => {
            sites.forEach(cursor => cursors.add(cursor));
        });
        return cursors;
    }
}
