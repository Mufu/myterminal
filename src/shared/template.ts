/**
 * 提示樣板的替換：`{{params.x}}` 與 `{{<節點id>.text}}`。
 * 編排層 (GraphCompiler) 與畫布上的「手動操作」看的是同一份實作，
 * 差別只在解析不出來的時候要代什麼 —— 所以把那件事交給呼叫者的 resolve。
 */

/** 回傳要代進去的字；回 undefined 代表「解析不出來」，整個 {{…}} 原樣留著。*/
export type TemplateResolver = (head: string, field: string) => string | undefined;

export function renderTemplate(template: string, resolve: TemplateResolver): string {
  return template.replace(
    /\{\{\s*([^.\s{}]+)\.([^.\s{}]+)\s*\}\}/g,
    (whole, head: string, field: string) => resolve(head, field) ?? whole,
  );
}
