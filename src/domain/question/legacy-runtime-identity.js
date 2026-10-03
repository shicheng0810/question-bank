    function getBanks(q){
      const out = [];
      if(q && Array.isArray(q.banks)) out.push(...q.banks);
      const id = String(q && q.id ? q.id : "");
      if(id.includes("-")) out.push(id.split("-")[0]);
      return Array.from(new Set(out.filter(Boolean)));
    }

    // 筛选面板的分类键：题目带 section（如雅思阅读的每篇文章）时按 section 分类，
    // 否则退回按题库前缀（getBanks）。section 键加 "§" 前缀，避免与题库前缀撞车。
    const SECTION_KEY_PREFIX = "§";
    function filterCategoriesOf(q){
      if(q && q.section) return [SECTION_KEY_PREFIX + String(q.section)];
      return getBanks(q);
    }

    // \u9898\u5e72\u5e26 HTML \u6807\u8bb0\u65f6\uff0c\u4ec5\u6309"\u7eaf\u6587\u672c"\u7b97 id \u2014\u2014 \u6807\u8bb0\uff08<b>/<span> \u7b49\uff09\u5728\u591a\u6b21\u53d1\u5e03\u95f4\u53d8\u52a8\u4e0d\u5e94
    // \u6539\u53d8 id\uff08\u5426\u5219\u8be5\u9898\u5386\u53f2\u65ad\u94fe\uff09\u3002\u4e0e\u5bfc\u51fa\u7aef normalizeTextForMerge(\u2192cleanHTMLString) \u5bf9\u9f50\uff1a\u53d6 textContent\u3002
    function stripHTMLForKey(s){
      if(s.indexOf("<") === -1) return s; // \u7eaf\u6587\u672c\u5feb\u8def\u5f84\uff1a\u4e0d\u5efa DOM
      try{
        const tpl = document.createElement("template");
        tpl.innerHTML = s;
        tpl.content.querySelectorAll("script,style").forEach(n=>n.remove());
        return tpl.content.textContent || "";
      }catch(_e){ return s; }
    }

    function normText(s){
      return stripHTMLForKey(String(s ?? ""))
        .replace(/\u00a0/g, " ")
        .trim()
        .toLowerCase()
        .replace(/\s+/g, " ");
    }

    function fnv1a64(str){
      let h = 0xcbf29ce484222325n;
      const prime = 0x100000001b3n;
      for(let i=0;i<str.length;i++){
        h ^= BigInt(str.charCodeAt(i));
        h = (h * prime) & 0xffffffffffffffffn;
      }
      return h.toString(16).padStart(16,"0");
    }

    function makeQuestionKey(q){
      const isFillQ = (q && (q.type === "fill" || Array.isArray(q.blanks)));
      const isEssayQ = (q && q.type === "essay");
      const isMultiQ = (q && Array.isArray(q.answers));
      const type = isFillQ ? "fill" : (isEssayQ ? "essay" : (isMultiQ ? "multi" : "single"));
      let key = type + "|" + normText(q && q.question);

      if(type === "fill"){
        const blanks = Array.isArray(q.blanks) ? q.blanks : [];
        const bParts = blanks.map(arr=>{
          const list = (Array.isArray(arr)?arr:[arr]).map(normText).filter(Boolean).sort();
          return list.join("/");
        });
        key += "|blanks:" + bParts.join("||");
      }else if(type === "essay"){
        // only question text
      }else{
        const choices = Array.isArray(q.choices) ? q.choices : [];
        const normChoices = choices.map(normText);

        // Smart merge: identify a question by stem + correct-answer text, independent of
        // distractor wording. The same question imported from two sources often has reworded /
        // reordered wrong options; those should still fuse.
        let correct;
        if(type === "multi"){
          const idxs = (Array.isArray(q.answers)?q.answers:[])
            .map(x=>Number(x))
            .filter(x=>Number.isFinite(x) && x>=0 && x<normChoices.length)
            .sort((a,b)=>a-b);
          correct = idxs.map(i=>normChoices[i]).filter(Boolean).sort();
        }else{
          const ai = Number(q.answer);
          const c = (Number.isFinite(ai) && ai>=0 && ai<normChoices.length) ? normChoices[ai] : "";
          correct = c ? [c] : [];
        }
        // Fall back to the full choice set only when the correct answer is unknown,
        // to avoid over-merging distinct unanswered questions that share a stem.
        if(!correct.length){
          key += "|choicebag:" + [...normChoices].sort().join("||");
        }
        key += "|correct:" + correct.join("||");
      }

      // 注意：key 不含图片指纹（与导出端 makeUniqueQuestionKey 同步）——同题一边有图
      // 一边缺图也应合并，图片在合并时取并集。
      return key;
    }
    /* TEST-EXPORT END */

    function mergeUnique(a,b){
      const out = [];
      const push = (x)=>{ if(x===null||x===undefined) return; const s=String(x); if(!s) return; if(!out.includes(s)) out.push(s); };
      (a||[]).forEach(push); (b||[]).forEach(push);
      return out;
    }

    function collectImageList(q){
      const img = q && q.image;
      if(!img) return [];
      const arr = Array.isArray(img) ? img : [img];
      return arr.filter(Boolean);
    }

    function setImageField(obj, list){
      const uniq = [];
      for(const s of list){
        if(!s) continue;
        if(!uniq.includes(s)) uniq.push(s);
      }
      if(!uniq.length){ delete obj.image; return; }
      obj.image = (uniq.length===1) ? uniq[0] : uniq;
    }

    // Dedupe identical questions, merge sources + banks, and build id alias mapping.
    function dedupeQuestionBank(raw){
      const byKey = new Map(); // key -> canonical question object
      const alias = {};
      const out = [];
      const list = Array.isArray(raw) ? raw : (raw ? [raw] : []);

      for(const q0 of list){
        if(!q0) continue;
        const key = makeQuestionKey(q0);
        let canon = byKey.get(key);

        if(!canon){
          const id = "q_" + fnv1a64(key);
          canon = { ...q0, id };
          // banks + source (start as arrays)
          canon.banks = getBanks(q0);
          const srcArr = Array.isArray(q0.source) ? q0.source : (q0.source ? [q0.source] : []);
          canon.source = mergeUnique([], srcArr);

          // merge images (keep union)
          setImageField(canon, collectImageList(q0));

          // keep one question_html if available
          if(q0.question_html) canon.question_html = q0.question_html;

          byKey.set(key, canon);
          out.push(canon);
        }else{
          // banks
          canon.banks = mergeUnique(canon.banks, getBanks(q0));

          // sources
          const srcArr = Array.isArray(q0.source) ? q0.source : (q0.source ? [q0.source] : []);
          canon.source = mergeUnique(canon.source, srcArr);

          // images
          setImageField(canon, mergeUnique(collectImageList(canon), collectImageList(q0)));

          // prefer having question_html
          if(!canon.question_html && q0.question_html) canon.question_html = q0.question_html;
        }

        // alias for old ids
        if(q0.id) alias[String(q0.id)] = canon.id;
      }

      // 二段合并（与导出端 buildUniqueMergedQuestionBankFromCollections 同步）：
      // 主 key 对「有答案/无答案」不对称，同题一份带答案一份不带会双份并存。把无答案的
      // 选择题按 题干+完整选项集合 匹配有答案的同题：恰好一条则吸收进去；多条（同干同
      // 选项不同答案）保持独立。
      const shapeKey = (q)=>{
        const cs = (Array.isArray(q.choices)?q.choices:[]).map(normText).sort();
        return normText(q.question) + "||" + cs.join("||");
      };
      const hasAns = (q)=> Array.isArray(q.answers) ? q.answers.length>0 : (Number.isFinite(Number(q.answer)) && Number(q.answer)>=0);
      const isChoiceQ = (q)=> Array.isArray(q.choices) && q.choices.length>0 && !(q.type==="fill"||Array.isArray(q.blanks));
      const ansByShape = new Map();
      for(const q of out){
        if(isChoiceQ(q) && hasAns(q)){
          const k = shapeKey(q);
          if(!ansByShape.has(k)) ansByShape.set(k, []);
          ansByShape.get(k).push(q);
        }
      }
      for(let i=out.length-1;i>=0;i--){
        const q = out[i];
        if(!isChoiceQ(q) || hasAns(q)) continue;
        const targets = ansByShape.get(shapeKey(q)) || [];
        if(targets.length !== 1) continue;
        const t = targets[0];
        t.banks = mergeUnique(t.banks, q.banks);
        t.source = mergeUnique(Array.isArray(t.source)?t.source:[t.source], Array.isArray(q.source)?q.source:[q.source]);
        setImageField(t, mergeUnique(collectImageList(t), collectImageList(q)));
        if(!t.question_html && q.question_html) t.question_html = q.question_html;
        for(const k0 of Object.keys(alias)) if(alias[k0] === q.id) alias[k0] = t.id;
        alias[q.id] = t.id;
        out.splice(i, 1);
      }

      // Normalize: if only one source, keep as string (backward friendly)
      out.forEach(q=>{
        if(Array.isArray(q.source)){
          q.source = q.source.length <= 1 ? (q.source[0] || "") : q.source;
        }
        if(Array.isArray(q.banks)){
          q.banks = q.banks.filter(Boolean);
        }
      });

      return { bank: out, alias };
    }


export { makeQuestionKey as makeLegacyQuestionKey, dedupeQuestionBank as dedupeLegacyQuestionBank };


