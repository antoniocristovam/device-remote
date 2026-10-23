import { rc } from '../rc';

export type EditCommand = 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll';

/** Returns true when the command was handled for the phone (the remote stage has focus). */
type StageHandler = (cmd: EditCommand) => boolean;

let stageHandler: StageHandler | null = null;

/** The session stage registers while mounted; menu edit commands go to it first. */
export function setStageEditHandler(h: StageHandler | null) {
  stageHandler = h;
}

/**
 * macOS menu edit commands (see main/menu.ts): the phone stage handles them when focused,
 * otherwise the focused local field gets the native action.
 */
export function installEditRouting() {
  return rc.app.onEditCommand((cmd) => {
    if (stageHandler?.(cmd)) return;
    void rc.app.nativeEdit(cmd);
  });
}
