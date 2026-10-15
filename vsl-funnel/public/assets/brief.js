'use strict';
(function(){
  var msg=document.querySelector('[data-msg]'),doc=document.querySelector('[data-doc]');
  // Copy first (synchronously, while this tab has focus), then open the new doc.
  document.querySelector('[data-gdoc]').onclick=function(){
    var ok=false,r=document.createRange(),sel=getSelection();
    r.selectNodeContents(doc);sel.removeAllRanges();sel.addRange(r);
    try{ok=document.execCommand('copy');}catch(e){ok=false;}
    sel.removeAllRanges();
    var w=window.open('https://docs.new','_blank');
    msg.textContent=ok?'Copied. In the new Google Doc press ⌘V (Mac) or Ctrl+V (Windows): the design comes with it.':'Your browser blocked copying: press ⌘A then ⌘C here, and paste into the new Google Doc.';
    if(!w)msg.textContent+=' (The new tab was blocked: open docs.new yourself.)';
  };
  document.querySelector('[data-print]').onclick=function(){window.print();};
  var m=document.querySelector('[data-miro]');
  if(m)m.onclick=function(){
    var w=window.open('about:blank','_blank');m.disabled=true;m.textContent='Building the board…';
    fetch('/admin/api/yt/sprints/'+encodeURIComponent(document.body.getAttribute('data-id'))+'/miro',{method:'POST',credentials:'same-origin'}).then(function(r){return r.json();}).then(function(r){
      if(!r.ok){if(w)w.close();m.disabled=false;m.textContent='Build the Miro board';msg.textContent=r.error||'Could not build the board.';return;}
      if(w)w.location=r.url;else location.href=r.url;
      var a=document.createElement('a');a.className='b ghost';a.href=r.url;a.target='_blank';a.textContent='Open the Miro board';m.replaceWith(a);
    },function(){if(w)w.close();m.disabled=false;m.textContent='Build the Miro board';msg.textContent='Could not reach the server.';});
  };
})();
