// 테마: 저장값 > 시스템. 껍데기가 먼저 칠해지도록 모듈보다 앞에 둔다.
(function(){
  var K="geoprobe-theme", v=null;
  try{ v=localStorage.getItem(K) }catch(e){}
  // ?theme=light|dark 는 저장하지 않고 이번 화면에만 적용한다(문서용 캡처·링크 공유).
  var q=new URLSearchParams(location.search).get("theme");
  if(q==="light"||q==="dark") v=q;
  if(v==="light"||v==="dark") document.documentElement.setAttribute("data-theme",v);
  function sync(){
    var cur=document.documentElement.getAttribute("data-theme");
    document.querySelectorAll("[data-theme-set]").forEach(function(b){
      b.setAttribute("aria-pressed", String(b.dataset.themeSet===cur));
    });
  }
  document.addEventListener("click",function(e){
    var b=e.target.closest("[data-theme-set]"); if(!b) return;
    var next=b.dataset.themeSet;
    if(document.documentElement.getAttribute("data-theme")===next){
      document.documentElement.removeAttribute("data-theme");
      try{ localStorage.removeItem(K) }catch(e){}
    }else{
      document.documentElement.setAttribute("data-theme",next);
      try{ localStorage.setItem(K,next) }catch(e){}
    }
    sync();
  });
  document.addEventListener("DOMContentLoaded",sync); sync();
})();
