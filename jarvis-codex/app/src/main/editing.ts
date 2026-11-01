import {Menu,type BrowserWindow,type ContextMenuParams,type MenuItemConstructorOptions} from 'electron';

// Native editing keeps clipboard access inside Chromium's focused text control.
// No clipboard-reading bridge or permission is exposed to the renderer.
export function installEditingMenu(){
 Menu.setApplicationMenu(Menu.buildFromTemplate([
  {label:'&Edit',submenu:[
   {role:'undo'},{role:'redo'},{type:'separator'},
   {role:'cut'},{role:'copy'},{role:'paste'},{type:'separator'},
   {role:'selectAll'}
  ]},
  {label:'&Window',submenu:[{role:'minimize'},{role:'close'},{type:'separator'},{role:'quit'}]}
 ]));
}

export function editingItems(params:ContextMenuParams):MenuItemConstructorOptions[]{
 const flags=params.editFlags;
 if(params.isEditable)return [
  {role:'undo',enabled:flags.canUndo},{role:'redo',enabled:flags.canRedo},
  {type:'separator'},
  {role:'cut',enabled:flags.canCut},{role:'copy',enabled:flags.canCopy},
  {role:'paste',enabled:flags.canPaste},
  {type:'separator'},{role:'selectAll',enabled:flags.canSelectAll}
 ];
 return params.selectionText.trim()?[{role:'copy',enabled:flags.canCopy},{role:'selectAll'}]:[];
}

export function installTextContextMenu(window:BrowserWindow){
 window.webContents.on('context-menu',(_event,params)=>{
  const items=editingItems(params);
  if(items.length)Menu.buildFromTemplate(items).popup({window});
 });
}
