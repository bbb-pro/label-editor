import bwipjs from 'bwip-js'
// bwip toCanvas in node needs a canvas; use bwip's generic render via raw+manual is hard.
// Instead simulate pixel extraction concept on raw geometry for 1D:
// 1D: sbs list of bar/space widths starting with BAR (quiet zone added separately)
// We'll print what raw gives and try to map quiet-zone handling by checking toCanvas output width is hard in node.
// Use SVG path instead: code128 with no includetext to see pure bars viewBox
const svg = bwipjs.toSVG({bcid:'code128', text:'ABC-123', height:14, width:2, scale:1, paddingwidth:4, paddingheight:4, includetext:false})
console.log('code128 no-text viewBox head:', svg.slice(0,120))
console.log('len', svg.length)
// qrcode
const svg2 = bwipjs.toSVG({bcid:'qrcode', text:'ABC', scale:1})
console.log('qrcode viewBox:', svg2.slice(0,60), 'len', svg2.length)
