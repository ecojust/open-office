export interface CalcSheet { index: number; name: string; visible: boolean }
export interface CalcSelection { sheetIndex: number; startColumn: number; startRow: number; endColumn: number; endRow: number; address: string; multiple: boolean }
export interface CalcCell { address: string; column: number; row: number; formula: string; text: string; value: number; type: 'empty'|'number'|'text'|'formula'; error: number }
export interface CalcCellPatch {address:string;kind:'empty'|'number'|'text'|'formula';value:string|number}
export interface CalcFormat { fontName: string; fontSize: number; bold: boolean; italic: boolean; textColor: string; backgroundColor: string|null; align: 'left'|'center'|'right'|'justify'|'default'; verticalAlign: 'top'|'center'|'bottom'|'default'; wrap: boolean; numberFormat: string; merged: boolean }
export interface CalcState {
  documentId: string; revision: number; dirty: boolean;
  sheets: CalcSheet[]; sheetCount: number; sheetsTruncated: boolean; activeSheetIndex: number; selection: CalcSelection; cell: CalcCell; format: CalcFormat;
  frozen: { columns: number; rows: number };
  namedRanges: Array<{ name: string; content: string }>;
}
type Scope = { sheetIndex?: number; range?: string }
type Version = { expectedRevision?: number }
export type CalcAction = Version & (
  | {type:'select-sheet';sheetIndex:number}
  | {type:'add-sheet';name?:string}
  | {type:'rename-sheet'|'duplicate-sheet';sheetIndex:number;name:string}
  | {type:'delete-sheet';sheetIndex:number}
  | {type:'move-sheet';sheetIndex:number;targetIndex:number}
  | {type:'set-sheet-hidden';sheetIndex:number;hidden:boolean}
  | {type:'select-range';sheetIndex?:number;range:string}
  | {type:'set-cell';sheetIndex?:number;address:string;input:string}
  | {type:'patch-cells';sheetIndex?:number;cells:CalcCellPatch[]}
  | ({type:'set-matrix';cells:Array<Array<string|number|boolean|null>>;formulas?:boolean} & Scope)
  | ({type:'format';fontName?:string;fontSize?:number;bold?:boolean;italic?:boolean;textColor?:string;backgroundColor?:string|null;align?:CalcFormat['align'];verticalAlign?:CalcFormat['verticalAlign'];wrap?:boolean;numberFormat?:string} & Scope)
  | ({type:'merge';merged:boolean} & Scope)
  | {type:'insert-rows'|'delete-rows'|'insert-columns'|'delete-columns';sheetIndex?:number;index:number;count:number}
  | {type:'set-row-height'|'set-column-width';sheetIndex?:number;index:number;count:number;sizeMm:number}
  | ({type:'sort';column:number;ascending:boolean;header:boolean} & Scope)
  | ({type:'filter';column:number;operator:'equal'|'not-equal'|'contains'|'greater'|'less';value:string|number;header:boolean} & Scope)
  | ({type:'clear-filter'} & Scope)
  | {type:'freeze';columns:number;rows:number}
  | ({type:'conditional-format';operator:'greater'|'less'|'equal'|'between';value:number;secondValue?:number;backgroundColor:string;textColor?:string} & Scope)
  | ({type:'clear-conditional-format'} & Scope)
  | ({type:'validation';kind:'none'|'whole'|'decimal'|'list';minimum?:number;maximum?:number;items?:string[];allowBlank?:boolean} & Scope)
  | {type:'define-name';name:string;sheetIndex?:number;range:string}
  | {type:'delete-name';name:string}
  | ({type:'insert-chart';name:string;chartType:'column'|'bar'|'line'|'pie';headerRow:boolean;headerColumn:boolean} & Scope)
  | ({type:'insert-pivot';name:string;rowField:number;dataField:number;operation:'sum'|'count'|'average';outputSheetIndex?:number;outputAddress:string} & Scope)
  | {type:'delete-chart'|'delete-pivot'|'refresh-pivot';sheetIndex?:number;name:string}
)
export type CalcDataQuery = {type:'range'|'rules';sheetIndex?:number;range:string} | {type:'charts'|'pivots';sheetIndex?:number}
export interface CalcDataIdentity { documentId:string;revision:number }
export interface CalcRangeData extends CalcDataIdentity {range:string;values:Array<Array<string|number|null>>;formulas:string[][];cellTypes:Array<Array<'empty'|'number'|'text'|'formula'>> }
export interface CalcRangeAddress { sheetIndex:number;startColumn:number;startRow:number;endColumn:number;endRow:number }
export interface CalcChartData extends CalcDataIdentity {items:Array<{name:string;ranges:CalcRangeAddress[];headerRow:boolean;headerColumn:boolean;chartType:'column'|'bar'|'line'|'pie'|'other'}>}
export interface CalcPivotData extends CalcDataIdentity {items:Array<{name:string;source:CalcRangeAddress;output:CalcRangeAddress;fields:Array<{name:string;index:number;orientation:'hidden'|'row'|'column'|'page'|'data'|'unknown';operation:'sum'|'count'|'average'|'other'}>}>}
export interface CalcRulesData extends CalcDataIdentity {range:string;validation:{kind:string;formula1:string;formula2:string;operator:string;allowBlank:boolean}|null;conditions:Array<{operator:string;formula1:string;formula2:string;styleName:string}>;filter:{enabled:boolean;header:boolean;fields:Array<{column:number;operator:string;value:string|number}>}|null}
