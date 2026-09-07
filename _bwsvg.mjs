import bwipjs from 'bwip-js'
function show(label,opts){
  try{
    const svg = bwipjs.toSVG(opts);
    const re = /<rect[^>]*\/>/g, rv = svg.match(re);
    const first = svg.slice(0,400).replace(/\n/g,' ');
    console.log('\n==', label, 'svg length', svg.length, 'rect count', rv?rv.length:0);
    console.log('head:', first.slice(0,250));
    if(rv) console.log('sample rects:', rv.slice(0,3).join(' '));
  }catch(e){ console.log(label,'ERR',e.message); }
}
show('code128', {bcid:'code128', text:'ABC-123', includetext:true, height:14, width:2, scale:1, paddingwidth:4, paddingheight:4});
show('qrcode', {bcid:'qrcode', text:'ABC', scale:1});
