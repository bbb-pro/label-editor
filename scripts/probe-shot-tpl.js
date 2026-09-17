// 截图指定模板，肉眼确认表格框线是否压住文字
const ctrl = window.__appCtrl
const id = new URLSearchParams(location.search).get('tpl') || 'food-nutrition'
const { TEMPLATE_LIBRARY, buildTemplateSpec } = await import('/src/lib/templateLibrary.ts')
const tpl = TEMPLATE_LIBRARY.find((t) => t.id === id)
ctrl.loadTemplate(buildTemplateSpec(tpl))
await new Promise((r) => setTimeout(r, 300))
if (ctrl.fitToView) ctrl.fitToView()
await new Promise((r) => setTimeout(r, 400))
return { loaded: id, objects: ctrl.canvas.getObjects().length }
