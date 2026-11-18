// 文件导入导出：全部走浏览器本地 File API，无服务器
export function downloadText(filename: string, text: string, mime = 'text/plain;charset=utf-8') {
  const blob = new Blob(['﻿', text], { type: mime });
  downloadBlob(filename, blob);
}

export function downloadBlob(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function readTextFile(file: File): Promise<string> {
  return file.text();
}

export function pickFile(accept: string, multiple = false): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.onchange = () => resolve(input.files ? Array.from(input.files) : []);
    input.click();
  });
}

/** 解析制表符/逗号分隔的粘贴块为二维字符串数组（支持 Excel 整块粘贴） */
export function parsePastedTable(text: string): string[][] {
  const rows = text.replace(/\r/g, '').split(/\n/).filter((r) => r.trim().length > 0);
  return rows.map((r) => r.split(/\t|,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map((c) => c.trim().replace(/^"|"$/g, '')));
}

export function toCsv(rows: (string | number)[][]): string {
  return rows
    .map((r) => r.map((c) => {
      const s = String(c ?? '');
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(','))
    .join('\n');
}

/** 简易 .xlsx/.xls 检测：本系统零依赖，xlsx 走“另存为 CSV”或直接粘贴 */
export function isExcelFile(name: string) {
  return /\.(xlsx|xls)$/i.test(name);
}
