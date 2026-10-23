import { rc } from '../rc';

export type EditCommand = 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll';

/** Returns true when the command was handled for a phone (its stage has focus). */
type StageHandler = (cmd: EditCommand) => boolean;

/** One handler per mounted phone stage (device view, grid tiles); only the focused one acts. */
const stageHandlers = new Set<StageHandler>();

export function addStageEditHandler(h: StageHandler) {
  stageHandlers.add(h);
  return () => void stageHandlers.delete(h);
}

/**
 * macOS menu edit commands (see main/menu.ts): the focused phone stage handles them,
 * otherwise the focused local field gets the native action.
 */
export function installEditRouting() {
  return rc.app.onEditCommand((cmd) => {
    for (const h of stageHandlers) if (h(cmd)) return;
    void rc.app.nativeEdit(cmd);
  });
}
