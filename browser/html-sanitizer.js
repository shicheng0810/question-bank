function rn(n, e) {
  (e == null || e > n.length) && (e = n.length);
  for (var i = 0, o = Array(e); i < e; i++) o[i] = n[i];
  return o;
}
function eo(n) {
  if (Array.isArray(n)) return n;
}
function no(n, e) {
  var i = n == null ? null : typeof Symbol < "u" && n[Symbol.iterator] || n["@@iterator"];
  if (i != null) {
    var o, s, p, d, b = [], g = !0, _ = !1;
    try {
      if (p = (i = i.call(n)).next, e !== 0) for (; !(g = (o = p.call(i)).done) && (b.push(o.value), b.length !== e); g = !0) ;
    } catch (c) {
      _ = !0, s = c;
    } finally {
      try {
        if (!g && i.return != null && (d = i.return(), Object(d) !== d)) return;
      } finally {
        if (_) throw s;
      }
    }
    return b;
  }
}
function oo() {
  throw new TypeError(`Invalid attempt to destructure non-iterable instance.
In order to be iterable, non-array objects must have a [Symbol.iterator]() method.`);
}
function ro(n, e) {
  return eo(n) || no(n, e) || io(n, e) || oo();
}
function io(n, e) {
  if (n) {
    if (typeof n == "string") return rn(n, e);
    var i = {}.toString.call(n).slice(8, -1);
    return i === "Object" && n.constructor && (i = n.constructor.name), i === "Map" || i === "Set" ? Array.from(n) : i === "Arguments" || /^(?:Ui|I)nt(?:8|16|32)(?:Clamped)?Array$/.test(i) ? rn(n, e) : void 0;
  }
}
const On = Object.entries, sn = Object.setPrototypeOf, so = Object.isFrozen, ao = Object.getPrototypeOf, lo = Object.getOwnPropertyDescriptor;
let j = Object.freeze, W = Object.seal, Dt = Object.create, Nn = typeof Reflect < "u" && Reflect, Ne = Nn.apply, Ie = Nn.construct;
j || (j = function(e) {
  return e;
});
W || (W = function(e) {
  return e;
});
Ne || (Ne = function(e, i) {
  for (var o = arguments.length, s = new Array(o > 2 ? o - 2 : 0), p = 2; p < o; p++) s[p - 2] = arguments[p];
  return e.apply(i, s);
});
Ie || (Ie = function(e) {
  for (var i = arguments.length, o = new Array(i > 1 ? i - 1 : 0), s = 1; s < i; s++) o[s - 1] = arguments[s];
  return new e(...o);
});
const Et = B(Array.prototype.forEach), co = B(Array.prototype.lastIndexOf), an = B(Array.prototype.pop), vt = B(Array.prototype.push), fo = B(Array.prototype.splice), wt = Array.isArray, Ht = B(String.prototype.toLowerCase), Ee = B(String.prototype.toString), ln = B(String.prototype.match), Ft = B(String.prototype.replace), cn = B(String.prototype.indexOf), uo = B(String.prototype.trim), po = B(Number.prototype.toString), mo = B(Boolean.prototype.toString), fn = typeof BigInt > "u" ? null : B(BigInt.prototype.toString), un = typeof Symbol > "u" ? null : B(Symbol.prototype.toString), J = B(Object.prototype.hasOwnProperty), Gt = B(Object.prototype.toString), Y = B(RegExp.prototype.test), ut = ho(TypeError);
function B(n) {
  return function(e) {
    e instanceof RegExp && (e.lastIndex = 0);
    for (var i = arguments.length, o = new Array(i > 1 ? i - 1 : 0), s = 1; s < i; s++) o[s - 1] = arguments[s];
    return Ne(n, e, o);
  };
}
function ho(n) {
  return function() {
    for (var e = arguments.length, i = new Array(e), o = 0; o < e; o++) i[o] = arguments[o];
    return Ie(n, i);
  };
}
function x(n, e) {
  let i = arguments.length > 2 && arguments[2] !== void 0 ? arguments[2] : Ht;
  if (sn && sn(n, null), !wt(e)) return n;
  let o = e.length;
  for (; o--; ) {
    let s = e[o];
    if (typeof s == "string") {
      const p = i(s);
      p !== s && (so(e) || (e[o] = p), s = p);
    }
    n[s] = !0;
  }
  return n;
}
function To(n) {
  for (let e = 0; e < n.length; e++) J(n, e) || (n[e] = null);
  return n;
}
function Z(n) {
  const e = Dt(null);
  for (const o of On(n)) {
    var i = ro(o, 2);
    const s = i[0], p = i[1];
    J(n, s) && (wt(p) ? e[s] = To(p) : p && typeof p == "object" && p.constructor === Object ? e[s] = Z(p) : e[s] = p);
  }
  return e;
}
function _o(n) {
  switch (typeof n) {
    case "string":
      return n;
    case "number":
      return po(n);
    case "boolean":
      return mo(n);
    case "bigint":
      return fn ? fn(n) : "0";
    case "symbol":
      return un ? un(n) : "Symbol()";
    case "undefined":
      return Gt(n);
    case "function":
    case "object": {
      if (n === null) return Gt(n);
      const e = n, i = tt(e, "toString");
      if (typeof i == "function") {
        const o = i(e);
        return typeof o == "string" ? o : Gt(o);
      }
      return Gt(n);
    }
    default:
      return Gt(n);
  }
}
function tt(n, e) {
  for (; n !== null; ) {
    const o = lo(n, e);
    if (o) {
      if (o.get) return B(o.get);
      if (typeof o.value == "function") return B(o.value);
    }
    n = ao(n);
  }
  function i() {
    return null;
  }
  return i;
}
function Eo(n) {
  try {
    return Y(n, ""), !0;
  } catch {
    return !1;
  }
}
const pn = j([
  "a",
  "abbr",
  "acronym",
  "address",
  "area",
  "article",
  "aside",
  "audio",
  "b",
  "bdi",
  "bdo",
  "big",
  "blink",
  "blockquote",
  "body",
  "br",
  "button",
  "canvas",
  "caption",
  "center",
  "cite",
  "code",
  "col",
  "colgroup",
  "content",
  "data",
  "datalist",
  "dd",
  "decorator",
  "del",
  "details",
  "dfn",
  "dialog",
  "dir",
  "div",
  "dl",
  "dt",
  "element",
  "em",
  "fieldset",
  "figcaption",
  "figure",
  "font",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "head",
  "header",
  "hgroup",
  "hr",
  "html",
  "i",
  "img",
  "input",
  "ins",
  "kbd",
  "label",
  "legend",
  "li",
  "main",
  "map",
  "mark",
  "marquee",
  "menu",
  "menuitem",
  "meter",
  "nav",
  "nobr",
  "ol",
  "optgroup",
  "option",
  "output",
  "p",
  "picture",
  "pre",
  "progress",
  "q",
  "rp",
  "rt",
  "ruby",
  "s",
  "samp",
  "search",
  "section",
  "select",
  "shadow",
  "slot",
  "small",
  "source",
  "spacer",
  "span",
  "strike",
  "strong",
  "style",
  "sub",
  "summary",
  "sup",
  "table",
  "tbody",
  "td",
  "template",
  "textarea",
  "tfoot",
  "th",
  "thead",
  "time",
  "tr",
  "track",
  "tt",
  "u",
  "ul",
  "var",
  "video",
  "wbr"
]), ge = j([
  "svg",
  "a",
  "altglyph",
  "altglyphdef",
  "altglyphitem",
  "animatecolor",
  "animatemotion",
  "animatetransform",
  "circle",
  "clippath",
  "defs",
  "desc",
  "ellipse",
  "enterkeyhint",
  "exportparts",
  "filter",
  "font",
  "g",
  "glyph",
  "glyphref",
  "hkern",
  "image",
  "inputmode",
  "line",
  "lineargradient",
  "marker",
  "mask",
  "metadata",
  "mpath",
  "part",
  "path",
  "pattern",
  "polygon",
  "polyline",
  "radialgradient",
  "rect",
  "stop",
  "style",
  "switch",
  "symbol",
  "text",
  "textpath",
  "title",
  "tref",
  "tspan",
  "view",
  "vkern"
]), Ae = j([
  "feBlend",
  "feColorMatrix",
  "feComponentTransfer",
  "feComposite",
  "feConvolveMatrix",
  "feDiffuseLighting",
  "feDisplacementMap",
  "feDistantLight",
  "feDropShadow",
  "feFlood",
  "feFuncA",
  "feFuncB",
  "feFuncG",
  "feFuncR",
  "feGaussianBlur",
  "feImage",
  "feMerge",
  "feMergeNode",
  "feMorphology",
  "feOffset",
  "fePointLight",
  "feSpecularLighting",
  "feSpotLight",
  "feTile",
  "feTurbulence"
]), go = j([
  "animate",
  "color-profile",
  "cursor",
  "discard",
  "font-face",
  "font-face-format",
  "font-face-name",
  "font-face-src",
  "font-face-uri",
  "foreignobject",
  "hatch",
  "hatchpath",
  "mesh",
  "meshgradient",
  "meshpatch",
  "meshrow",
  "missing-glyph",
  "script",
  "set",
  "solidcolor",
  "unknown",
  "use"
]), be = j([
  "math",
  "menclose",
  "merror",
  "mfenced",
  "mfrac",
  "mglyph",
  "mi",
  "mlabeledtr",
  "mmultiscripts",
  "mn",
  "mo",
  "mover",
  "mpadded",
  "mphantom",
  "mroot",
  "mrow",
  "ms",
  "mspace",
  "msqrt",
  "mstyle",
  "msub",
  "msup",
  "msubsup",
  "mtable",
  "mtd",
  "mtext",
  "mtr",
  "munder",
  "munderover",
  "mprescripts"
]), Ao = j([
  "maction",
  "maligngroup",
  "malignmark",
  "mlongdiv",
  "mscarries",
  "mscarry",
  "msgroup",
  "mstack",
  "msline",
  "msrow",
  "semantics",
  "annotation",
  "annotation-xml",
  "mprescripts",
  "none"
]), mn = j(["#text"]), dn = j([
  "accept",
  "action",
  "align",
  "alt",
  "autocapitalize",
  "autocomplete",
  "autopictureinpicture",
  "autoplay",
  "background",
  "bgcolor",
  "border",
  "capture",
  "cellpadding",
  "cellspacing",
  "checked",
  "cite",
  "class",
  "clear",
  "color",
  "cols",
  "colspan",
  "command",
  "commandfor",
  "controls",
  "controlslist",
  "coords",
  "crossorigin",
  "datetime",
  "decoding",
  "default",
  "dir",
  "disabled",
  "disablepictureinpicture",
  "disableremoteplayback",
  "download",
  "draggable",
  "enctype",
  "enterkeyhint",
  "exportparts",
  "face",
  "for",
  "headers",
  "height",
  "hidden",
  "high",
  "href",
  "hreflang",
  "id",
  "inert",
  "inputmode",
  "integrity",
  "ismap",
  "kind",
  "label",
  "lang",
  "list",
  "loading",
  "loop",
  "low",
  "max",
  "maxlength",
  "media",
  "method",
  "min",
  "minlength",
  "multiple",
  "muted",
  "name",
  "nonce",
  "noshade",
  "novalidate",
  "nowrap",
  "open",
  "optimum",
  "part",
  "pattern",
  "placeholder",
  "playsinline",
  "popover",
  "popovertarget",
  "popovertargetaction",
  "poster",
  "preload",
  "pubdate",
  "radiogroup",
  "readonly",
  "rel",
  "required",
  "rev",
  "reversed",
  "role",
  "rows",
  "rowspan",
  "spellcheck",
  "scope",
  "selected",
  "shape",
  "size",
  "sizes",
  "slot",
  "span",
  "srclang",
  "start",
  "src",
  "srcset",
  "step",
  "style",
  "summary",
  "tabindex",
  "title",
  "translate",
  "type",
  "usemap",
  "valign",
  "value",
  "width",
  "wrap",
  "xmlns"
]), ye = j([
  "accent-height",
  "accumulate",
  "additive",
  "alignment-baseline",
  "amplitude",
  "ascent",
  "attributename",
  "attributetype",
  "azimuth",
  "basefrequency",
  "baseline-shift",
  "begin",
  "bias",
  "by",
  "class",
  "clip",
  "clippathunits",
  "clip-path",
  "clip-rule",
  "color",
  "color-interpolation",
  "color-interpolation-filters",
  "color-profile",
  "color-rendering",
  "cx",
  "cy",
  "d",
  "dx",
  "dy",
  "diffuseconstant",
  "direction",
  "display",
  "divisor",
  "dominant-baseline",
  "dur",
  "edgemode",
  "elevation",
  "end",
  "exponent",
  "fill",
  "fill-opacity",
  "fill-rule",
  "filter",
  "filterunits",
  "flood-color",
  "flood-opacity",
  "font-family",
  "font-size",
  "font-size-adjust",
  "font-stretch",
  "font-style",
  "font-variant",
  "font-weight",
  "fx",
  "fy",
  "g1",
  "g2",
  "glyph-name",
  "glyphref",
  "gradientunits",
  "gradienttransform",
  "height",
  "href",
  "id",
  "image-rendering",
  "in",
  "in2",
  "intercept",
  "k",
  "k1",
  "k2",
  "k3",
  "k4",
  "kerning",
  "keypoints",
  "keysplines",
  "keytimes",
  "lang",
  "lengthadjust",
  "letter-spacing",
  "kernelmatrix",
  "kernelunitlength",
  "lighting-color",
  "local",
  "marker-end",
  "marker-mid",
  "marker-start",
  "markerheight",
  "markerunits",
  "markerwidth",
  "maskcontentunits",
  "maskunits",
  "max",
  "mask",
  "mask-type",
  "media",
  "method",
  "mode",
  "min",
  "name",
  "numoctaves",
  "offset",
  "operator",
  "opacity",
  "order",
  "orient",
  "orientation",
  "origin",
  "overflow",
  "paint-order",
  "path",
  "pathlength",
  "patterncontentunits",
  "patterntransform",
  "patternunits",
  "pointer-events",
  "points",
  "preservealpha",
  "preserveaspectratio",
  "primitiveunits",
  "r",
  "rx",
  "ry",
  "radius",
  "refx",
  "refy",
  "repeatcount",
  "repeatdur",
  "restart",
  "result",
  "rotate",
  "scale",
  "seed",
  "shape-rendering",
  "slope",
  "specularconstant",
  "specularexponent",
  "spreadmethod",
  "startoffset",
  "stddeviation",
  "stitchtiles",
  "stop-color",
  "stop-opacity",
  "stroke-dasharray",
  "stroke-dashoffset",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-miterlimit",
  "stroke-opacity",
  "stroke",
  "stroke-width",
  "style",
  "surfacescale",
  "systemlanguage",
  "tabindex",
  "tablevalues",
  "targetx",
  "targety",
  "transform",
  "transform-origin",
  "text-anchor",
  "text-decoration",
  "text-orientation",
  "text-rendering",
  "textlength",
  "type",
  "u1",
  "u2",
  "unicode",
  "values",
  "vector-effect",
  "viewbox",
  "visibility",
  "version",
  "vert-adv-y",
  "vert-origin-x",
  "vert-origin-y",
  "width",
  "word-spacing",
  "wrap",
  "writing-mode",
  "xchannelselector",
  "ychannelselector",
  "x",
  "x1",
  "x2",
  "xmlns",
  "y",
  "y1",
  "y2",
  "z",
  "zoomandpan"
]), hn = j([
  "accent",
  "accentunder",
  "align",
  "bevelled",
  "close",
  "columnalign",
  "columnlines",
  "columnspacing",
  "columnspan",
  "denomalign",
  "depth",
  "dir",
  "display",
  "displaystyle",
  "encoding",
  "fence",
  "frame",
  "height",
  "href",
  "id",
  "largeop",
  "length",
  "linethickness",
  "lquote",
  "lspace",
  "mathbackground",
  "mathcolor",
  "mathsize",
  "mathvariant",
  "maxsize",
  "minsize",
  "movablelimits",
  "notation",
  "numalign",
  "open",
  "rowalign",
  "rowlines",
  "rowspacing",
  "rowspan",
  "rspace",
  "rquote",
  "scriptlevel",
  "scriptminsize",
  "scriptsizemultiplier",
  "selection",
  "separator",
  "separators",
  "stretchy",
  "subscriptshift",
  "supscriptshift",
  "symmetric",
  "voffset",
  "width",
  "xmlns"
]), te = j([
  "xlink:href",
  "xml:id",
  "xlink:title",
  "xml:space",
  "xmlns:xlink"
]), bo = W(/{{[\w\W]*|^[\w\W]*}}/g), yo = W(/<%[\w\W]*|^[\w\W]*%>/g), So = W(/\${[\w\W]*/g), Ro = W(/^data-[\-\w.\u00B7-\uFFFF]+$/), Oo = W(/^aria-[\-\w]+$/), Tn = W(/^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|matrix):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i), No = W(/^(?:\w+script|data):/i), Io = W(/[\u0000-\u0020\u00A0\u1680\u180E\u2000-\u2029\u205F\u3000]/g), Lo = W(/^html$/i), xo = W(/^[a-z][.\w]*(-[.\w]+)+$/i), _n = W(/<[/\w!]/g), En = W(/<[/\w]/g), Do = W(/<\/no(script|embed|frames)/i), wo = W(/\/>/i), K = {
  element: 1,
  attribute: 2,
  text: 3,
  cdataSection: 4,
  entityReference: 5,
  entityNode: 6,
  processingInstruction: 7,
  comment: 8,
  document: 9,
  documentType: 10,
  documentFragment: 11,
  notation: 12
}, In = [
  "style",
  "script",
  "xmp",
  "iframe",
  "noembed",
  "noframes",
  "plaintext",
  "noscript"
], Po = j(x({}, In)), Co = (function() {
  const n = {};
  return Et(In, (e) => {
    n[e] = W(new RegExp("</" + e + "(?=[\\t\\n\\f\\r />])", "i"));
  }), j(n);
})(), Mo = function() {
  return typeof window > "u" ? null : window;
}, Uo = function(e, i) {
  if (typeof e != "object" || typeof e.createPolicy != "function") return null;
  let o = null;
  const s = "data-tt-policy-suffix";
  i && i.hasAttribute(s) && (o = i.getAttribute(s));
  const p = "dompurify" + (o ? "#" + o : "");
  try {
    return e.createPolicy(p, {
      createHTML(d) {
        return d;
      },
      createScriptURL(d) {
        return d;
      }
    });
  } catch {
    return console.warn("TrustedTypes policy " + p + " could not be created."), null;
  }
}, gn = function() {
  return {
    afterSanitizeAttributes: [],
    afterSanitizeElements: [],
    afterSanitizeShadowDOM: [],
    beforeSanitizeAttributes: [],
    beforeSanitizeElements: [],
    beforeSanitizeShadowDOM: [],
    uponSanitizeAttribute: [],
    uponSanitizeElement: [],
    uponSanitizeShadowNode: []
  };
}, pt = function(e, i, o, s) {
  return J(e, i) && wt(e[i]) ? x(s.base ? Z(s.base) : {}, e[i], s.transform) : o;
}, Se = function(e, i, o) {
  const s = J(e, i) ? e[i] : void 0;
  return s && typeof s == "object" ? Z(s) : o();
};
function Ln() {
  let n = arguments.length > 0 && arguments[0] !== void 0 ? arguments[0] : Mo();
  const e = (l) => Ln(l);
  if (e.version = "3.4.16", e.removed = [], !n || !n.document || n.document.nodeType !== K.document || !n.Element)
    return e.isSupported = !1, e;
  let i = n.document;
  const o = i, s = o.currentScript;
  n.DocumentFragment;
  const p = n.HTMLTemplateElement, d = n.Node, b = n.Element, g = n.NodeFilter;
  n.NamedNodeMap === void 0 && (n.NamedNodeMap || n.MozNamedAttrMap), n.HTMLFormElement;
  const _ = n.DOMParser, c = n.trustedTypes, u = b.prototype, D = tt(u, "cloneNode"), E = tt(u, "remove"), I = tt(u, "removeAttributeNode"), m = tt(u, "nextSibling"), y = tt(u, "childNodes"), A = tt(u, "parentNode"), S = tt(u, "shadowRoot"), P = tt(u, "attributes"), O = d && d.prototype ? tt(d.prototype, "nodeType") : null, R = d && d.prototype ? tt(d.prototype, "nodeName") : null, C = d && d.prototype ? tt(d.prototype, "ownerDocument") : null, F = function(t) {
    return O ? O(t) : t.nodeType;
  }, H = function(t) {
    return R ? R(t) : t.nodeName;
  };
  if (typeof p == "function") {
    const l = i.createElement("template");
    l.content && l.content.ownerDocument && (i = l.content.ownerDocument);
  }
  let w, M = "", X, et = !1, nt = 0;
  const gt = function() {
    if (nt > 0) throw ut('A configured TRUSTED_TYPES_POLICY callback (createHTML or createScriptURL) must not call DOMPurify.sanitize, as that causes infinite recursion. Do not pass a policy whose callbacks wrap DOMPurify as TRUSTED_TYPES_POLICY; see the "DOMPurify and Trusted Types" section of the README.');
  }, V = function(t) {
    gt(), nt++;
    try {
      return w.createHTML(t);
    } finally {
      nt--;
    }
  }, at = function(t) {
    gt(), nt++;
    try {
      return w.createScriptURL(t);
    } finally {
      nt--;
    }
  }, At = function() {
    return et || (X = Uo(c, s), et = !0), X;
  }, dt = i, bt = dt.implementation, Pt = dt.createNodeIterator, Ct = dt.createDocumentFragment, Dn = dt.getElementsByTagName, wn = o.importNode;
  let U = gn();
  e.isSupported = typeof On == "function" && typeof A == "function" && bt && bt.createHTMLDocument !== void 0;
  const Pn = bo, Cn = yo, Mn = So, Un = Ro, kn = Oo, vn = No, xe = Io, Fn = xo;
  let De = Tn, k = null;
  const oe = x({}, [
    ...pn,
    ...ge,
    ...Ae,
    ...be,
    ...mn
  ]);
  let v = null;
  const re = x({}, [
    ...dn,
    ...ye,
    ...hn,
    ...te
  ]);
  let ot = Object.seal(Dt(null, {
    tagNameCheck: {
      writable: !0,
      configurable: !1,
      enumerable: !0,
      value: null
    },
    attributeNameCheck: {
      writable: !0,
      configurable: !1,
      enumerable: !0,
      value: null
    },
    allowCustomizedBuiltInElements: {
      writable: !0,
      configurable: !1,
      enumerable: !0,
      value: !1
    }
  })), Mt = null, we = null;
  const lt = Object.seal(Dt(null, {
    tagCheck: {
      writable: !0,
      configurable: !1,
      enumerable: !0,
      value: null
    },
    attributeCheck: {
      writable: !0,
      configurable: !1,
      enumerable: !0,
      value: null
    }
  }));
  let Pe = !0, ie = !0, Ce = !1, Me = !0, ct = !1, ht = !0, Tt = !1, se = !1, Bt = null, jt = null, ae = !1, yt = !1, Wt = !1, Yt = !1, Ue = !0, ke = !1;
  const ve = "user-content-";
  let le = !0, ce = !1, St = {}, Rt = null;
  const Fe = x({}, [
    "annotation-xml",
    "audio",
    "colgroup",
    "desc",
    "foreignobject",
    "head",
    "iframe",
    "math",
    "mi",
    "mn",
    "mo",
    "ms",
    "mtext",
    "noembed",
    "noframes",
    "noscript",
    "plaintext",
    "script",
    "selectedcontent",
    "style",
    "svg",
    "template",
    "thead",
    "title",
    "video",
    "xmp"
  ]);
  let Ge = null;
  const He = x({}, [
    "audio",
    "video",
    "img",
    "source",
    "image",
    "track"
  ]);
  let ze = null;
  const Be = x({}, [
    "alt",
    "class",
    "for",
    "id",
    "label",
    "name",
    "pattern",
    "placeholder",
    "role",
    "summary",
    "title",
    "value",
    "style",
    "xmlns"
  ]), $t = "http://www.w3.org/1998/Math/MathML", Xt = "http://www.w3.org/2000/svg", rt = "http://www.w3.org/1999/xhtml";
  let Ot = rt, fe = !1, ue = null;
  const Gn = x({}, [
    $t,
    Xt,
    rt
  ], Ee), je = j([
    "mi",
    "mo",
    "mn",
    "ms",
    "mtext"
  ]);
  let pe = x({}, je);
  const We = j(["annotation-xml"]);
  let me = x({}, We);
  const Hn = x({}, [
    "title",
    "style",
    "font",
    "a",
    "script"
  ]);
  let Ut = null;
  const zn = ["application/xhtml+xml", "text/html"], Bn = "text/html";
  let z = null, Nt = null;
  const jn = i.createElement("form"), Ye = function(t) {
    return t instanceof RegExp || t instanceof Function;
  }, de = function() {
    let t = arguments.length > 0 && arguments[0] !== void 0 ? arguments[0] : {};
    if (Nt && Nt === t) return;
    (!t || typeof t != "object") && (t = {}), t = Z(t), Ut = zn.indexOf(t.PARSER_MEDIA_TYPE) === -1 ? Bn : t.PARSER_MEDIA_TYPE, z = Ut === "application/xhtml+xml" ? Ee : Ht, k = pt(t, "ALLOWED_TAGS", oe, { transform: z }), v = pt(t, "ALLOWED_ATTR", re, { transform: z }), ue = pt(t, "ALLOWED_NAMESPACES", Gn, { transform: Ee }), ze = pt(t, "ADD_URI_SAFE_ATTR", Be, {
      transform: z,
      base: Be
    }), Ge = pt(t, "ADD_DATA_URI_TAGS", He, {
      transform: z,
      base: He
    }), Rt = pt(t, "FORBID_CONTENTS", Fe, { transform: z }), Mt = pt(t, "FORBID_TAGS", Z({}), { transform: z }), we = pt(t, "FORBID_ATTR", Z({}), { transform: z }), St = J(t, "USE_PROFILES") ? t.USE_PROFILES && typeof t.USE_PROFILES == "object" ? Z(t.USE_PROFILES) : t.USE_PROFILES : !1, Pe = t.ALLOW_ARIA_ATTR !== !1, ie = t.ALLOW_DATA_ATTR !== !1, Ce = t.ALLOW_UNKNOWN_PROTOCOLS || !1, Me = t.ALLOW_SELF_CLOSE_IN_ATTR !== !1, ct = t.SAFE_FOR_TEMPLATES || !1, ht = t.SAFE_FOR_XML !== !1, Tt = t.WHOLE_DOCUMENT || !1, yt = t.RETURN_DOM || !1, Wt = t.RETURN_DOM_FRAGMENT || !1, Yt = t.RETURN_TRUSTED_TYPE || !1, ae = t.FORCE_BODY || !1, Ue = t.SANITIZE_DOM !== !1, ke = t.SANITIZE_NAMED_PROPS || !1, le = t.KEEP_CONTENT !== !1, ce = t.IN_PLACE || !1, De = Eo(t.ALLOWED_URI_REGEXP) ? t.ALLOWED_URI_REGEXP : Tn, Ot = typeof t.NAMESPACE == "string" ? t.NAMESPACE : rt, pe = Se(t, "MATHML_TEXT_INTEGRATION_POINTS", () => x({}, je)), me = Se(t, "HTML_INTEGRATION_POINTS", () => x({}, We));
    const r = Se(t, "CUSTOM_ELEMENT_HANDLING", () => Dt(null));
    if (ot = Dt(null), J(r, "tagNameCheck") && Ye(r.tagNameCheck) && (ot.tagNameCheck = r.tagNameCheck), J(r, "attributeNameCheck") && Ye(r.attributeNameCheck) && (ot.attributeNameCheck = r.attributeNameCheck), J(r, "allowCustomizedBuiltInElements") && typeof r.allowCustomizedBuiltInElements == "boolean" && (ot.allowCustomizedBuiltInElements = r.allowCustomizedBuiltInElements), W(ot), ct && (ie = !1), Wt && (yt = !0), St && (k = x({}, mn), v = Dt(null), St.html === !0 && (x(k, pn), x(v, dn)), St.svg === !0 && (x(k, ge), x(v, ye), x(v, te)), St.svgFilters === !0 && (x(k, Ae), x(v, ye), x(v, te)), St.mathMl === !0 && (x(k, be), x(v, hn), x(v, te))), lt.tagCheck = null, lt.attributeCheck = null, J(t, "ADD_TAGS") && (typeof t.ADD_TAGS == "function" ? lt.tagCheck = t.ADD_TAGS : wt(t.ADD_TAGS) && (k === oe && (k = Z(k)), x(k, t.ADD_TAGS, z))), J(t, "ADD_ATTR") && (typeof t.ADD_ATTR == "function" ? lt.attributeCheck = t.ADD_ATTR : wt(t.ADD_ATTR) && (v === re && (v = Z(v)), x(v, t.ADD_ATTR, z))), J(t, "ADD_FORBID_CONTENTS") && wt(t.ADD_FORBID_CONTENTS) && (Rt === Fe && (Rt = Z(Rt)), x(Rt, t.ADD_FORBID_CONTENTS, z)), le && (k["#text"] = !0), Tt && x(k, [
      "html",
      "head",
      "body"
    ]), k.table && (x(k, ["tbody"]), delete Mt.tbody), t.TRUSTED_TYPES_POLICY) {
      if (typeof t.TRUSTED_TYPES_POLICY.createHTML != "function") throw ut('TRUSTED_TYPES_POLICY configuration option must provide a "createHTML" hook.');
      if (typeof t.TRUSTED_TYPES_POLICY.createScriptURL != "function") throw ut('TRUSTED_TYPES_POLICY configuration option must provide a "createScriptURL" hook.');
      const a = w;
      w = t.TRUSTED_TYPES_POLICY;
      try {
        M = V("");
      } catch (f) {
        throw w = a, f;
      }
    } else t.TRUSTED_TYPES_POLICY === null ? (w = void 0, M = "") : (w === void 0 && (w = At()), w && typeof M == "string" && (M = V("")));
    j && j(t), Nt = t;
  }, $e = x({}, [
    ...ge,
    ...Ae,
    ...go
  ]), Xe = x({}, [...be, ...Ao]), Wn = function(t, r, a) {
    return r.namespaceURI === rt ? t === "svg" : r.namespaceURI === $t ? t === "svg" && (a === "annotation-xml" || pe[a]) : !!$e[t];
  }, Yn = function(t, r, a) {
    return r.namespaceURI === rt ? t === "math" : r.namespaceURI === Xt ? t === "math" && me[a] : !!Xe[t];
  }, $n = function(t, r, a) {
    return r.namespaceURI === Xt && !me[a] || r.namespaceURI === $t && !pe[a] ? !1 : !Xe[t] && (Hn[t] || !$e[t]);
  }, Xn = function(t) {
    let r = A(t);
    (!r || !r.tagName) && (r = {
      namespaceURI: Ot,
      tagName: "template"
    });
    const a = Ht(t.tagName), f = Ht(r.tagName);
    return ue[t.namespaceURI] ? t.namespaceURI === Xt ? Wn(a, r, f) : t.namespaceURI === $t ? Yn(a, r, f) : t.namespaceURI === rt ? $n(a, r, f) : !!(Ut === "application/xhtml+xml" && ue[t.namespaceURI]) : !1;
  }, ft = function(t) {
    vt(e.removed, { element: t });
    try {
      A(t).removeChild(t);
    } catch {
      if (E(t), !A(t)) throw ut("a node selected for removal could not be detached from its tree and cannot be safely returned; refusing to sanitize in place");
    }
  }, Je = function(t, r, a) {
    try {
      I(t, r);
    } catch {
      try {
        t.removeAttribute(a);
      } catch {
      }
    }
  }, Jt = function(t) {
    Vt(t);
    const r = y(t);
    if (r) {
      const f = [];
      Et(r, (T) => {
        vt(f, T);
      }), Et(f, (T) => {
        try {
          E(T);
        } catch {
        }
      });
    }
    const a = P(t);
    if (a) for (let f = a.length - 1; f >= 0; --f) {
      const T = a[f], N = T && T.name;
      typeof N == "string" && Je(t, T, N);
    }
  }, _t = function(t, r, a) {
    if (!a) try {
      a = r.getAttributeNode(t);
    } catch {
      a = null;
    }
    vt(e.removed, {
      attribute: a || null,
      from: r
    });
    try {
      a ? I(r, a) : r.removeAttribute(t);
    } catch {
      try {
        r.removeAttribute(t);
      } catch {
      }
    }
    if (t === "is")
      if (yt || Wt) try {
        ft(r);
      } catch {
      }
      else try {
        r.setAttribute(t, "");
      } catch {
      }
  }, Jn = function(t) {
    const r = P(t);
    if (r)
      for (let a = r.length - 1; a >= 0; --a) {
        const f = r[a], T = f && f.name;
        typeof T != "string" || v[z(T)] || Je(t, f, T);
      }
  }, Vt = function(t) {
    const r = [t];
    for (; r.length > 0; ) {
      const a = r.pop();
      F(a) === K.element && Jn(a);
      const f = y(a);
      if (f) for (let T = f.length - 1; T >= 0; --T) r.push(f[T]);
    }
  }, Ve = function(t, r) {
    return ht ? t === "patchsrc" ? !0 : t === "for" && r !== "label" && r !== "output" : !1;
  }, Vn = function(t) {
    if (!ht) return;
    const r = [t];
    for (; r.length > 0; ) {
      const a = r.pop(), f = F(a);
      if (f === K.processingInstruction || f === K.comment && Y(En, a.data)) {
        try {
          E(a);
        } catch {
        }
        continue;
      }
      if (f === K.element) {
        const N = a, L = z(H(a));
        try {
          N.hasAttribute && N.hasAttribute("patchsrc") && N.removeAttribute("patchsrc"), N.hasAttribute && N.hasAttribute("for") && Ve("for", L) && N.removeAttribute("for");
        } catch {
        }
      }
      const T = y(a);
      if (T) for (let N = T.length - 1; N >= 0; --N) r.push(T[N]);
    }
  }, qe = function(t) {
    let r = null, a = null;
    if (ae) t = "<remove></remove>" + t;
    else {
      const N = ln(t, /^[\r\n\t ]+/);
      a = N && N[0];
    }
    Ut === "application/xhtml+xml" && Ot === rt && (t = '<html xmlns="http://www.w3.org/1999/xhtml"><head></head><body>' + t + "</body></html>");
    const f = w ? V(t) : t;
    if (Ot === rt) try {
      r = new _().parseFromString(f, Ut);
    } catch {
    }
    if (!r || !r.documentElement) {
      r = bt.createDocument(Ot, "template", null);
      try {
        r.documentElement.innerHTML = fe ? M : f;
      } catch {
      }
    }
    const T = r.body || r.documentElement;
    return t && a && T.insertBefore(i.createTextNode(a), T.childNodes[0] || null), Ot === rt ? Dn.call(r, Tt ? "html" : "body")[0] : Tt ? r.documentElement : T;
  }, Ke = function(t) {
    const r = C ? C(t) : t.ownerDocument;
    return Pt.call(r || t, t, g.SHOW_ELEMENT | g.SHOW_COMMENT | g.SHOW_TEXT | g.SHOW_PROCESSING_INSTRUCTION | g.SHOW_CDATA_SECTION, null);
  }, qt = function(t) {
    return t = Ft(t, Pn, " "), t = Ft(t, Cn, " "), t = Ft(t, Mn, " "), t;
  }, he = function(t) {
    var r;
    t.normalize();
    const a = C ? C(t) : t.ownerDocument, f = Pt.call(a || t, t, g.SHOW_TEXT | g.SHOW_COMMENT | g.SHOW_CDATA_SECTION | g.SHOW_PROCESSING_INSTRUCTION, null);
    let T = f.nextNode();
    for (; T; )
      T.data = qt(T.data), T = f.nextNode();
    const N = (r = t.querySelectorAll) === null || r === void 0 ? void 0 : r.call(t, "template");
    N && Et(N, (L) => {
      It(L.content) && he(L.content);
    });
  }, Kt = function(t) {
    const r = R ? R(t) : null;
    return typeof r != "string" || z(r) !== "form" ? !1 : typeof t.nodeName != "string" || typeof t.textContent != "string" || typeof t.removeChild != "function" || t.attributes !== P(t) || typeof t.removeAttribute != "function" || typeof t.removeAttributeNode != "function" || typeof t.getAttributeNode != "function" || typeof t.setAttribute != "function" || typeof t.namespaceURI != "string" || typeof t.insertBefore != "function" || typeof t.hasChildNodes != "function" || t.nodeType !== O(t) || t.childNodes !== y(t);
  }, It = function(t) {
    if (!O || typeof t != "object" || t === null) return !1;
    try {
      return O(t) === K.documentFragment;
    } catch {
      return !1;
    }
  }, kt = function(t) {
    if (!O || typeof t != "object" || t === null) return !1;
    try {
      return typeof O(t) == "number";
    } catch {
      return !1;
    }
  };
  function it(l, t, r) {
    l.length !== 0 && Et(l, (a) => {
      a.call(e, t, r, Nt);
    });
  }
  const qn = function(t, r) {
    return !!(ht && t.hasChildNodes() && !kt(t.firstElementChild) && Y(_n, t.textContent) && Y(_n, t.innerHTML) || ht && t.namespaceURI === rt && Po[r] && (kt(t.firstElementChild) || typeof t.textContent == "string" && Y(Co[r], t.textContent)) || t.nodeType === K.processingInstruction || ht && t.nodeType === K.comment && Y(En, t.data));
  }, Zt = function(t, r) {
    if (t instanceof RegExp) return Y(t, r);
    if (t instanceof Function) {
      for (var a = arguments.length, f = new Array(a > 2 ? a - 2 : 0), T = 2; T < a; T++) f[T - 2] = arguments[T];
      return !!t(r, ...f);
    }
    return !1;
  }, Kn = function(t, r, a) {
    if (!Mt[r] && en(r) && Zt(ot.tagNameCheck, r)) return !1;
    if (le && !Rt[r]) {
      const f = A(t), T = y(t);
      if (T && f) {
        const N = T.length;
        for (let L = N - 1; L >= 0; --L) {
          const G = t === a ? D(T[L], !0) : T[L];
          f.insertBefore(G, m(t));
        }
      }
    }
    return ft(t), !0;
  }, Ze = function(t, r, a, f) {
    return t.length === 0 ? r : r === a || r === f ? Z(r) : r;
  }, Lt = function(t, r) {
    return t === r || A(t) !== null ? !1 : (ce && Vt(t), !0);
  }, Qe = function(t, r) {
    if (it(U.beforeSanitizeElements, t, null), Lt(t, r)) return !0;
    if (Kt(t))
      return ft(t), !0;
    const a = z(H(t));
    if (k = Ze(U.uponSanitizeElement, k, oe, Bt), it(U.uponSanitizeElement, t, {
      tagName: a,
      allowedTags: k
    }), Lt(t, r)) return !0;
    if (qn(t, a))
      return ft(t), !0;
    if (Mt[a] || !(lt.tagCheck instanceof Function && lt.tagCheck(a)) && !k[a]) {
      const f = Kn(t, a, r);
      return f === !1 && (it(U.afterSanitizeElements, t, null), Lt(t, r)) ? !0 : f;
    }
    if (F(t) === K.element && !Xn(t) || (a === "noscript" || a === "noembed" || a === "noframes") && Y(Do, t.innerHTML))
      return ft(t), !0;
    if (ct && t.nodeType === K.text) {
      const f = qt(t.textContent);
      t.textContent !== f && (vt(e.removed, { element: t.cloneNode() }), t.textContent = f);
    }
    return it(U.afterSanitizeElements, t, null), Lt(t, r);
  }, tn = function(t, r, a) {
    if (we[r] || Ve(r, t) || Ue && (r === "id" || r === "name") && (a in i || a in jn)) return !1;
    const f = v[r] || lt.attributeCheck instanceof Function && lt.attributeCheck(r, t);
    return ie && Y(Un, r) || Pe && Y(kn, r) ? !0 : f ? ze[r] || Y(De, Ft(a, xe, "")) || (r === "src" || r === "xlink:href" || r === "href") && t !== "script" && cn(a, "data:") === 0 && Ge[t] || Ce && !Y(vn, Ft(a, xe, "")) ? !0 : !a : en(t) && Zt(ot.tagNameCheck, t) && Zt(ot.attributeNameCheck, r, t) || r === "is" && ot.allowCustomizedBuiltInElements && Zt(ot.tagNameCheck, a);
  }, Zn = x({}, [
    "annotation-xml",
    "color-profile",
    "font-face",
    "font-face-format",
    "font-face-name",
    "font-face-src",
    "font-face-uri",
    "missing-glyph"
  ]), en = function(t) {
    return !Zn[Ht(t)] && Y(Fn, t);
  }, Qn = function(t, r, a, f) {
    if (w && typeof c == "object" && typeof c.getAttributeType == "function" && !a) switch (c.getAttributeType(t, r)) {
      case "TrustedHTML":
        return V(f);
      case "TrustedScriptURL":
        return at(f);
    }
    return f;
  }, to = function(t, r, a, f) {
    try {
      return a ? t.setAttributeNS(a, r, f) : t.setAttribute(r, f), Kt(t) ? (ft(t), !1) : !0;
    } catch {
      return _t(r, t), !1;
    }
  }, nn = function(t, r) {
    if (it(U.beforeSanitizeAttributes, t, null), Lt(t, r)) return;
    const a = t.attributes;
    if (!a || Kt(t)) return;
    v = Ze(U.uponSanitizeAttribute, v, re, jt);
    const f = {
      attrName: "",
      attrValue: "",
      keepAttr: !0,
      allowedAttributes: v,
      forceKeepAttr: void 0
    };
    let T = a.length;
    const N = z(t.nodeName);
    for (; T--; ) {
      const L = a[T], G = L.name, Q = L.namespaceURI, q = L.value, xt = z(G), _e = q;
      let $ = G === "value" ? _e : uo(_e), on = !1;
      if (f.attrName = xt, f.attrValue = $, f.keepAttr = !0, f.forceKeepAttr = void 0, it(U.uponSanitizeAttribute, t, f), $ = f.attrValue, ke && (xt === "id" || xt === "name") && cn($, ve) !== 0 && (_t(G, t, L), $ = ve + $, on = !0), ht && Y(/((--!?|])>)|<\/(style|script|title|xmp|textarea|noscript|iframe|noembed|noframes)/i, $)) {
        _t(G, t, L);
        continue;
      }
      if (xt === "attributename" && ln($, "href")) {
        _t(G, t, L);
        continue;
      }
      if (!f.forceKeepAttr) {
        if (!f.keepAttr) {
          _t(G, t, L);
          continue;
        }
        if (!Me && Y(wo, $)) {
          _t(G, t, L);
          continue;
        }
        if (ct && ($ = qt($)), !tn(N, xt, $)) {
          _t(G, t, L);
          continue;
        }
        $ = Qn(N, xt, Q, $), $ !== _e && to(t, G, Q, $) && on && an(e.removed);
      }
    }
    it(U.afterSanitizeAttributes, t, null), Lt(t, r);
  }, Qt = function(t) {
    let r = null;
    const a = Ke(t);
    for (it(U.beforeSanitizeShadowDOM, t, null); r = a.nextNode(); )
      if (it(U.uponSanitizeShadowNode, r, null), Qe(r, t), nn(r, t), It(r.content) && Qt(r.content), F(r) === K.element) {
        const f = S(r);
        It(f) && (Te(f), Qt(f));
      }
    it(U.afterSanitizeShadowDOM, t, null);
  }, Te = function(t) {
    const r = [{
      node: t,
      shadow: null
    }];
    for (; r.length > 0; ) {
      const a = r.pop();
      if (a.shadow) {
        Qt(a.shadow);
        continue;
      }
      const f = a.node, T = F(f) === K.element, N = y(f);
      if (N) for (let L = N.length - 1; L >= 0; --L) r.push({
        node: N[L],
        shadow: null
      });
      if (T) {
        const L = R ? R(f) : null;
        if (typeof L == "string" && z(L) === "template") {
          const G = f.content;
          It(G) && r.push({
            node: G,
            shadow: null
          });
        }
      }
      if (T) {
        const L = S(f);
        It(L) && r.push({
          node: null,
          shadow: L
        }, {
          node: L,
          shadow: null
        });
      }
    }
  };
  return e.sanitize = function(l) {
    let t = arguments.length > 1 && arguments[1] !== void 0 ? arguments[1] : {}, r = null, a = null, f = null, T = null;
    if (fe = !l, fe && (l = "<!-->"), typeof l != "string" && !kt(l) && (l = _o(l), typeof l != "string"))
      throw ut("dirty is not a string, aborting");
    if (!e.isSupported) return l;
    se ? (k = Bt, v = jt) : de(t), (U.uponSanitizeElement.length > 0 || U.uponSanitizeAttribute.length > 0) && (k = Z(k)), U.uponSanitizeAttribute.length > 0 && (v = Z(v)), e.removed = [];
    const N = ce && typeof l != "string" && kt(l);
    if (N) {
      Vn(l);
      const Q = H(l);
      if (typeof Q == "string") {
        const q = z(Q);
        if (!k[q] || Mt[q])
          throw Jt(l), ut("root node is forbidden and cannot be sanitized in-place");
      }
      if (Kt(l))
        throw Jt(l), ut("root node is clobbered and cannot be sanitized in-place");
      try {
        Te(l);
      } catch (q) {
        throw Jt(l), q;
      }
    } else if (kt(l))
      r = qe("<!---->"), a = r.ownerDocument.importNode(l, !0), a.nodeType === K.element && a.nodeName === "BODY" || a.nodeName === "HTML" ? r = a : r.appendChild(a), Te(r);
    else {
      if (!yt && !ct && !Tt && l.indexOf("<") === -1) return w && Yt ? V(l) : l;
      if (r = qe(l), !r) return yt ? null : Yt ? M : "";
    }
    r && ae && ft(r.firstChild);
    const L = N ? l : r;
    try {
      const Q = Ke(L);
      for (; f = Q.nextNode(); )
        Qe(f, L), nn(f, L), It(f.content) && Qt(f.content);
    } catch (Q) {
      throw N && (Jt(l), Et(e.removed, (q) => {
        q.element && Vt(q.element);
      })), Q;
    }
    if (N) {
      let Q = !1;
      if (Et(e.removed, (q) => {
        q.element && (q.element === l && (Q = !0), Vt(q.element));
      }), Q) throw ut("a node selected for removal could not be safely returned; refusing to sanitize in place");
      return ct && he(l), l;
    }
    if (yt) {
      if (ct && he(r), Wt)
        for (T = Ct.call(r.ownerDocument); r.firstChild; ) T.appendChild(r.firstChild);
      else T = r;
      return (v.shadowroot || v.shadowrootmode) && (T = wn.call(o, T, !0)), T;
    }
    let G = Tt ? r.outerHTML : r.innerHTML;
    return Tt && k["!doctype"] && r.ownerDocument && r.ownerDocument.doctype && r.ownerDocument.doctype.name && Y(Lo, r.ownerDocument.doctype.name) && (G = "<!DOCTYPE " + r.ownerDocument.doctype.name + `>
` + G), ct && (G = qt(G)), w && Yt ? V(G) : G;
  }, e.setConfig = function() {
    let l = arguments.length > 0 && arguments[0] !== void 0 ? arguments[0] : {};
    de(l), se = !0, Bt = k, jt = v;
  }, e.clearConfig = function() {
    Nt = null, se = !1, Bt = null, jt = null, w = X, M = "";
  }, e.isValidAttribute = function(l, t, r) {
    Nt || de({});
    const a = z(l), f = z(t);
    return tn(a, f, r);
  }, e.addHook = function(l, t) {
    typeof t == "function" && J(U, l) && vt(U[l], t);
  }, e.removeHook = function(l, t) {
    if (J(U, l)) {
      if (t !== void 0) {
        const r = co(U[l], t);
        return r === -1 ? void 0 : fo(U[l], r, 1)[0];
      }
      return an(U[l]);
    }
  }, e.removeHooks = function(l) {
    J(U, l) && (U[l] = []);
  }, e.removeAllHooks = function() {
    U = gn();
  }, e;
}
var ko = Ln();
const vo = "3.4.16", Fo = "http://www.w3.org/1999/xhtml", Go = ["p", "br", "span", "div", "strong", "b", "em", "i", "u", "s", "sub", "sup", "blockquote", "pre", "code", "ul", "ol", "li", "table", "thead", "tbody", "tfoot", "tr", "td", "th", "caption", "hr", "figure", "figcaption", "img"], An = ["svg", "math", "script", "style", "form", "label", "button", "textarea", "select", "option", "iframe", "object", "embed", "video", "audio", "source", "track", "link", "meta", "base", "template"], Le = /[\u0000-\u0020\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/, zt = (n) => Object.assign(new Error(n), { code: n });
function Ho(n) {
  if (!n || Object.getPrototypeOf(n) !== Object.prototype || Reflect.ownKeys(n).some((p) => typeof p != "string") || Object.keys(n).sort().join() !== "blanksCount,html,mode") throw zt("QUESTION_HTML_INPUT");
  const e = Object.getOwnPropertyDescriptors(n);
  for (const p of Object.values(e)) if (!p.enumerable || !Object.hasOwn(p, "value")) throw zt("QUESTION_HTML_INPUT");
  const { html: i, mode: o, blanksCount: s } = Object.fromEntries(Object.entries(e).map(([p, d]) => [p, d.value]));
  if (typeof i != "string" || !["question-inline", "choice"].includes(o) || !Number.isSafeInteger(s) || s < 0 || s > 5e3 || i.length > 3 * 1024 * 1024 || new TextEncoder().encode(i).length > 3 * 1024 * 1024) throw zt("QUESTION_HTML_INPUT");
  return { html: i, mode: o, blanksCount: s };
}
function zo(n, e) {
  if (typeof n != "string" || !n || Le.test(n) || n.includes("\\")) return null;
  let i = n;
  try {
    for (let o = 0; o < 3; o++) {
      const s = decodeURIComponent(i);
      if (Le.test(s) || s.includes("\\")) return null;
      if (s === i) break;
      i = s;
    }
  } catch {
    return null;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(i) && !/^https?:/i.test(i)) return null;
  try {
    const o = new URL(n, e + "/");
    return o.username || o.password || !(o.protocol === "https:" || o.origin === e && o.protocol === "http:") ? null : o.href;
  } catch {
    return null;
  }
}
function Bo(n, e) {
  if (typeof n != "string" || Le.test(n) || n.includes("\\") || n.includes("%") || n.includes("?") || n.includes("#")) return null;
  try {
    const i = new URL(n, e + "/");
    return i.origin !== e || i.username || i.password || !/^\/(assets|banks)\/[a-z0-9_./-]+\.(png|jpe?g|gif|webp|avif)$/i.test(i.pathname) ? null : i.href;
  } catch {
    return null;
  }
}
function pr(n) {
  const e = n;
  if (!e?.document?.createDocumentFragment || !e.Element?.prototype || !e.Node?.prototype) throw zt("BROWSER_DOM_REQUIRED");
  const i = e.location.origin;
  if (!/^https?:\/\//.test(i)) throw zt("TRUSTED_HTML_ORIGIN_REQUIRED");
  const o = (p, d) => e.Element.prototype.getAttribute.call(p, d), s = (p) => {
    p.parentNode && e.Node.prototype.removeChild.call(p.parentNode, p);
  };
  return Object.freeze({ sanitize(p) {
    const { html: d, mode: b, blanksCount: g } = Ho(p), _ = ko(e);
    if (_.version !== vo || _.isSupported !== !0) {
      const E = e.document.createDocumentFragment();
      return E.appendChild(e.document.createTextNode(d)), Object.freeze({ fragment: E, mode: "plaintext", degraded: !0 });
    }
    const c = /* @__PURE__ */ new Set(), u = b === "question-inline";
    _.addHook("uponSanitizeElement", (E, I) => {
      if (E.nodeType !== 1) return;
      if (E.namespaceURI !== Fo) {
        s(E);
        return;
      }
      if (I.tagName !== "input") return;
      const m = o(E, "data-blank");
      let y = E.parentNode, A = !1;
      for (; y && y.nodeType === 1; ) {
        if (["a", "button", "input", "label", "form"].includes(y.localName)) {
          A = !0;
          break;
        }
        y = y.parentNode;
      }
      const S = o(E, "type"), P = o(E, "class");
      if (!u || A || S !== null && S !== "text" || P !== null && P !== "qb-blank" || !m || !/^[1-9][0-9]{0,3}$/.test(m) || Number(m) > g || c.has(m)) {
        s(E);
        return;
      }
      c.add(m), e.Element.prototype.setAttribute.call(E, "type", "text"), e.Element.prototype.setAttribute.call(E, "class", "qb-blank");
    }), _.addHook("uponSanitizeAttribute", (E, I) => {
      const m = I.attrName, y = E.localName;
      if (I.keepAttr = !1, m === "title" || m === "alt" && y === "img") {
        I.keepAttr = !0;
        return;
      }
      if (["colspan", "rowspan"].includes(m) && ["td", "th"].includes(y) && /^[1-9][0-9]{0,2}$/.test(I.attrValue) && Number(I.attrValue) <= 100) {
        I.keepAttr = !0;
        return;
      }
      if (y === "a" && u && m === "href") {
        const A = zo(I.attrValue, i);
        A && (I.attrValue = A, I.keepAttr = !0);
        return;
      }
      if (y === "img" && m === "src") {
        const A = Bo(I.attrValue, i);
        A && (I.attrValue = A, I.keepAttr = !0);
        return;
      }
      y === "input" && u && ["type", "class", "data-blank"].includes(m) && (I.keepAttr = !0);
    }), _.addHook("afterSanitizeAttributes", (E) => {
      E.nodeType === 1 && (E.localName === "a" && o(E, "href") && (e.Element.prototype.setAttribute.call(E, "rel", "noopener noreferrer"), e.Element.prototype.setAttribute.call(E, "target", "_blank")), E.localName === "img" && !o(E, "src") && s(E));
    });
    const D = _.sanitize(d, { ALLOWED_TAGS: [...Go, ...u ? ["a", "input"] : []], ALLOWED_ATTR: ["title", "alt", "colspan", "rowspan", "href", "src", "type", "class", "data-blank"], FORBID_TAGS: An, FORBID_CONTENTS: An, FORBID_ATTR: ["style", "id", "name", "value", "autofocus", "srcset", "ping", "download", "form", "formaction"], ALLOW_DATA_ATTR: !1, ALLOW_ARIA_ATTR: !1, ALLOW_UNKNOWN_PROTOCOLS: !1, CUSTOM_ELEMENT_HANDLING: { tagNameCheck: null, attributeNameCheck: null, allowCustomizedBuiltInElements: !1 }, SANITIZE_DOM: !0, SANITIZE_NAMED_PROPS: !0, RETURN_DOM_FRAGMENT: !0, RETURN_TRUSTED_TYPE: !1 });
    return Object.freeze({ fragment: D, mode: b, degraded: !1 });
  } });
}
const jo = (n) => n / 2 ** 32 | 0, Wo = (n) => n >>> 0;
function Yo(n, e, i, o) {
  const s = jo(i), p = Wo(i);
  n.setUint32(e, o ? p : s, o), n.setUint32(e + 4, o ? s : p, o);
}
function bn(n) {
  return n instanceof Uint8Array || ArrayBuffer.isView(n) && n.constructor.name === "Uint8Array" && "BYTES_PER_ELEMENT" in n && n.BYTES_PER_ELEMENT === 1;
}
const $o = (n) => n ? `"${n}" ` : "";
function xn(n, e, i = "") {
  if (bn(n) && e === void 0)
    return n;
  const o = bn(n), s = "", p = o ? `length=${n.length}` : `type=${typeof n}`, d = $o(i) + "expected Uint8Array" + s + ", got " + p;
  throw o ? new RangeError(d) : new TypeError(d);
}
const Xo = (n, e) => {
  if (n === null || typeof n != "object" || Array.isArray(n))
    throw new TypeError((e === "object" ? "" : `"${e}" `) + "expected object, got type=" + typeof n);
}, yn = (n, e) => {
  Xo(n, e);
  const i = Object.getPrototypeOf(n);
  if (i !== Object.prototype && i !== null)
    throw new TypeError(`"${e}" expected plain object`);
  if (Object.hasOwn(n, "__proto__"))
    throw new TypeError(`"${e}.__proto__" is not allowed`);
};
function Sn(n, e = !0) {
  if (n.destroyed)
    throw new Error("hash was destroyed");
  if (e && n.finished)
    throw new Error("digest() was already called");
}
function Jo(n, e) {
  xn(n, void 0, "output");
  const i = e.outputLen;
  if (!(n.length >= i))
    throw new RangeError('"output" expected length >= ' + i);
}
function Rn(...n) {
  for (let e = 0; e < n.length; e++)
    n[e].fill(0);
}
function Re(n) {
  return new DataView(n.buffer, n.byteOffset, n.byteLength);
}
function st(n, e) {
  return n << 32 - e | n >>> e;
}
function Vo(n, e, i = "opts") {
  return yn(n, "defaults"), e !== void 0 && yn(e, i), Object.assign(/* @__PURE__ */ Object.create(null), n, e);
}
function qo(n, e = {}) {
  if (typeof n != "function")
    throw new TypeError('"hashCons" expected function, got type=' + typeof n);
  e = Vo({}, e, "info");
  const i = (s, p) => n(p).update(s).digest(), o = n(void 0);
  return i.outputLen = o.outputLen, i.blockLen = o.blockLen, i.canXOF = o.canXOF, i.create = (s) => n(s), Object.assign(i, e), Object.freeze(i);
}
const Ko = (n) => ({
  // Current NIST hashAlgs suffixes used here fit in one DER subidentifier octet.
  // Larger suffix values would need base-128 OID encoding and a different length byte.
  oid: Uint8Array.from([6, 9, 96, 134, 72, 1, 101, 3, 4, 2, n])
});
function Zo(n, e, i) {
  return n & e ^ ~n & i;
}
function Qo(n, e, i) {
  return n & e ^ n & i ^ e & i;
}
class tr {
  blockLen;
  outputLen;
  canXOF = !1;
  padOffset;
  isLE;
  // For partial updates less than block size
  buffer;
  view;
  finished = !1;
  length = 0;
  pos = 0;
  destroyed = !1;
  constructor(e, i, o, s) {
    this.blockLen = e, this.outputLen = i, this.padOffset = o, this.isLE = s, this.buffer = new Uint8Array(e), this.view = Re(this.buffer);
  }
  update(e) {
    Sn(this), xn(e);
    const { view: i, buffer: o, blockLen: s } = this, p = e.length;
    let d = !1;
    for (let b = 0; b < p; ) {
      const g = Math.min(s - this.pos, p - b);
      if (g === s) {
        const _ = Re(e);
        for (; s <= p - b; b += s)
          this.process(_, b);
        d = !0;
        continue;
      }
      o.set(b === 0 && g === p ? e : e.subarray(b, b + g), this.pos), this.pos += g, b += g, this.pos === s && (this.process(i, 0), this.pos = 0, d = !0);
    }
    return this.length += e.length, d && this.roundClean(), this;
  }
  digestInto(e) {
    Sn(this), Jo(e, this), this.finished = !0;
    const { buffer: i, view: o, blockLen: s, isLE: p } = this;
    let { pos: d } = this;
    i[d++] = 128, i.fill(0, d), this.padOffset > s - d && (this.process(o, 0), i.fill(0)), Yo(o, s - 8, this.length * 8, p), this.process(o, 0), this.roundClean();
    const b = e === i ? o : Re(e), g = this.outputLen, _ = g / 4, c = this.get();
    if (g % 4 || _ > c.length)
      throw new Error("invalid outputLen");
    for (let u = 0; u < _; u++)
      b.setUint32(4 * u, c[u], p);
  }
  digest() {
    const { buffer: e, outputLen: i } = this;
    this.digestInto(e);
    const o = e.slice(0, i);
    return this.destroy(), o;
  }
  _cloneIntoMeta(e) {
    const { buffer: i, length: o, finished: s, destroyed: p, pos: d } = this;
    return e.destroyed = p, e.finished = s, e.length = o, e.pos = d, d && e.buffer.set(i), e;
  }
  clone() {
    return this._cloneInto();
  }
}
const er = /* @__PURE__ */ Uint32Array.from([
  1779033703,
  3144134277,
  1013904242,
  2773480762,
  1359893119,
  2600822924,
  528734635,
  1541459225
]), nr = /* @__PURE__ */ Uint32Array.from([
  1116352408,
  1899447441,
  3049323471,
  3921009573,
  961987163,
  1508970993,
  2453635748,
  2870763221,
  3624381080,
  310598401,
  607225278,
  1426881987,
  1925078388,
  2162078206,
  2614888103,
  3248222580,
  3835390401,
  4022224774,
  264347078,
  604807628,
  770255983,
  1249150122,
  1555081692,
  1996064986,
  2554220882,
  2821834349,
  2952996808,
  3210313671,
  3336571891,
  3584528711,
  113926993,
  338241895,
  666307205,
  773529912,
  1294757372,
  1396182291,
  1695183700,
  1986661051,
  2177026350,
  2456956037,
  2730485921,
  2820302411,
  3259730800,
  3345764771,
  3516065817,
  3600352804,
  4094571909,
  275423344,
  430227734,
  506948616,
  659060556,
  883997877,
  958139571,
  1322822218,
  1537002063,
  1747873779,
  1955562222,
  2024104815,
  2227730452,
  2361852424,
  2428436474,
  2756734187,
  3204031479,
  3329325298
]), mt = /* @__PURE__ */ new Uint32Array(64);
class or extends tr {
  // We cannot use array here since array allows indexing by variable
  // which means optimizer/compiler cannot use registers.
  // Numeric initializers matter: starting the fields as `undefined` changes
  // V8's field representation and makes sha256 3x slower (measured).
  A = 0;
  B = 0;
  C = 0;
  D = 0;
  E = 0;
  F = 0;
  G = 0;
  H = 0;
  constructor(e, i) {
    super(64, e, 8, !1), this.A = i[0] | 0, this.B = i[1] | 0, this.C = i[2] | 0, this.D = i[3] | 0, this.E = i[4] | 0, this.F = i[5] | 0, this.G = i[6] | 0, this.H = i[7] | 0;
  }
  get() {
    const { A: e, B: i, C: o, D: s, E: p, F: d, G: b, H: g } = this;
    return [e, i, o, s, p, d, b, g];
  }
  // prettier-ignore
  set(e, i, o, s, p, d, b, g) {
    this.A = e | 0, this.B = i | 0, this.C = o | 0, this.D = s | 0, this.E = p | 0, this.F = d | 0, this.G = b | 0, this.H = g | 0;
  }
  _cloneInto(e) {
    return (e ||= new this.constructor()).set(...this.get()), this._cloneIntoMeta(e);
  }
  process(e, i) {
    for (let u = 0; u < 16; u++, i += 4)
      mt[u] = e.getUint32(i, !1);
    for (let u = 16; u < 64; u++) {
      const D = mt[u - 15], E = mt[u - 2], I = st(D, 7) ^ st(D, 18) ^ D >>> 3, m = st(E, 17) ^ st(E, 19) ^ E >>> 10;
      mt[u] = m + mt[u - 7] + I + mt[u - 16] | 0;
    }
    let { A: o, B: s, C: p, D: d, E: b, F: g, G: _, H: c } = this;
    for (let u = 0; u < 64; u++) {
      const D = st(b, 6) ^ st(b, 11) ^ st(b, 25), E = c + D + Zo(b, g, _) + nr[u] + mt[u] | 0, m = (st(o, 2) ^ st(o, 13) ^ st(o, 22)) + Qo(o, s, p) | 0;
      c = _, _ = g, g = b, b = d + E | 0, d = p, p = s, s = o, o = E + m | 0;
    }
    o = o + this.A | 0, s = s + this.B | 0, p = p + this.C | 0, d = d + this.D | 0, b = b + this.E | 0, g = g + this.F | 0, _ = _ + this.G | 0, c = c + this.H | 0, this.set(o, s, p, d, b, g, _, c);
  }
  roundClean() {
    Rn(mt);
  }
  destroy() {
    this.destroyed = !0, this.set(0, 0, 0, 0, 0, 0, 0, 0), Rn(this.buffer);
  }
}
class rr extends or {
  constructor() {
    super(32, er);
  }
}
const ir = /* @__PURE__ */ qo(
  () => new rr(),
  /* @__PURE__ */ Ko(1)
), ne = 8 * 1024 * 1024, Oe = 16777216, sr = "35a68cb2-b871-4d37-9447-190c396eaf99/e9b05621-6f45-4f12-ae99-edd728545229", ar = "7dddd407905ddabfe91f02f7ad88c3d677c7453380b35bf8e2af11e05cf43f92", lr = "7f08055976e55a5a38d9517e28b1e895d1304054b0dca2f0601e2835cfd7ed22";
function cr(n, e, i) {
  return n !== sr || i !== ar || typeof e != "string" || e.length > Math.ceil(ne / 3) * 4 + 32 || !e.startsWith("data:image/jpeg;base64,") ? e : Array.from(ir(new TextEncoder().encode(e)), (s) => s.toString(16).padStart(2, "0")).join("") === lr ? "data:image/png;base64," + e.slice(23) : e;
}
const h = (n) => {
  throw Object.assign(new Error(n), { code: n });
}, ee = (n, e) => {
  (!Number.isInteger(n) || !Number.isInteger(e) || n < 1 || e < 1 || n > 4096 || e > 4096) && h("RASTER_DIMENSIONS");
};
function fr(n) {
  let e = 4294967295;
  for (const i of n) {
    e ^= i;
    for (let o = 0; o < 8; o++) e = e >>> 1 ^ (e & 1 ? 3988292384 : 0);
  }
  return (e ^ 4294967295) >>> 0;
}
function ur(n) {
  (typeof n != "string" || n.length > Math.ceil(ne / 3) * 4 + 32) && h("RASTER_BUDGET");
  const e = /^data:image\/(gif|png|jpeg);base64,([A-Za-z0-9+/]*={0,2})$/.exec(n);
  (!e || !e[2] || e[2].length % 4 !== 0) && h("RASTER_FORMAT");
  const i = atob(e[2]);
  (!i.length || i.length > ne || btoa(i) !== e[2]) && h("RASTER_BASE64");
  const o = Uint8Array.from(i, (c) => c.charCodeAt(0)), s = new DataView(o.buffer);
  let p, d, b = 0, g = 0;
  const _ = (c, u) => {
    (c < 0 || u < 0 || c + u > o.length) && h("RASTER_TRUNCATED");
  };
  if (e[1] === "gif") {
    _(0, 13);
    const c = String.fromCharCode(...o.subarray(0, 6));
    ["GIF87a", "GIF89a"].includes(c) || h("RASTER_MAGIC"), p = s.getUint16(6, !0), d = s.getUint16(8, !0), ee(p, d);
    let u = 13;
    const D = o[10];
    if (D & 128) {
      const m = 3 * (1 << (D & 7) + 1);
      _(u, m), u += m;
    }
    const E = () => {
      let m = 0;
      for (; ; ) {
        _(u, 1);
        const y = o[u++];
        if (!y) return m;
        _(u, y), u += y, m += y;
      }
    };
    let I = !1;
    for (; u < o.length; ) {
      const m = o[u++];
      if (m === 59) {
        I = !0;
        break;
      }
      if (m === 33) {
        _(u, 1);
        const y = o[u++];
        if (y === 249)
          _(u, 6), (o[u] !== 4 || o[u + 5] !== 0) && h("GIF_EXTENSION"), u += 6;
        else if (y === 254) E();
        else if (y === 255 || y === 1) {
          _(u, 1);
          const A = o[u++];
          A !== (y === 255 ? 11 : 12) && h("GIF_EXTENSION"), _(u, A), u += A, E();
        } else h("GIF_EXTENSION");
      } else if (m === 44) {
        _(u, 9);
        const y = s.getUint16(u, !0), A = s.getUint16(u + 2, !0), S = s.getUint16(u + 4, !0), P = s.getUint16(u + 6, !0), O = o[u + 8];
        if (ee(S, P), (y + S > p || A + P > d || O & 24) && h("GIF_FRAME"), g += S * P, (++b > 120 || g > Oe) && h("GIF_FRAME_BUDGET"), u += 9, O & 128) {
          const R = 3 * (1 << (O & 7) + 1);
          _(u, R), u += R;
        }
        _(u, 1), (o[u] < 2 || o[u] > 8) && h("GIF_LZW"), u++, E() || h("GIF_EMPTY_FRAME");
      } else h("GIF_STRUCTURE");
    }
    (!I || u !== o.length || b < 1) && h("GIF_TRAILER");
  } else if (e[1] === "jpeg") {
    _(0, 2), (o[0] !== 255 || o[1] !== 216) && h("RASTER_MAGIC");
    let c = 2, u, D, E = !1, I = 0, m = 0;
    const y = /* @__PURE__ */ new Set(), A = /* @__PURE__ */ new Set();
    for (; c < o.length; ) {
      for (_(c, 2), o[c++] !== 255 && h("JPEG_MARKER"); o[c] === 255; )
        c++, _(c, 1);
      const S = o[c++];
      if (S === 217) {
        (!D || I < 1 || c !== o.length) && h("JPEG_TRAILER"), E = !0;
        break;
      }
      (S === 0 || S === 216 || S === 1 || S >= 208 && S <= 215) && h("JPEG_MARKER"), _(c, 2);
      const P = s.getUint16(c);
      P < 2 && h("JPEG_SEGMENT"), _(c, P);
      const O = c + P;
      if (S === 192 || S === 194) {
        (D || I) && h("JPEG_FRAME"), _(c, 8);
        const R = o[c + 7];
        (o[c + 2] !== 8 || ![1, 3].includes(R) || P !== 8 + 3 * R) && h("JPEG_FRAME"), d = s.getUint16(c + 3), p = s.getUint16(c + 5), ee(p, d), g = p * d, g > Oe && h("RASTER_PIXEL_BUDGET"), D = /* @__PURE__ */ new Map();
        let C = 0;
        for (let F = 0; F < R; F++) {
          const H = c + 8 + 3 * F, w = o[H], M = o[H + 1] >> 4, X = o[H + 1] & 15, et = o[H + 2];
          (D.has(w) || M < 1 || M > 4 || X < 1 || X > 4 || et > 3) && h("JPEG_FRAME"), D.set(w, et), C += M * X;
        }
        C > 10 && h("JPEG_FRAME"), u = S;
      } else if (S === 219) {
        let R = c + 2;
        for (; R < O; ) {
          const C = o[R++];
          (C >> 4 !== 0 || (C & 15) > 3 || R + 64 > O) && h("JPEG_QUANTIZATION");
          for (let F = 0; F < 64; F++) o[R + F] === 0 && h("JPEG_QUANTIZATION");
          y.add(C & 15), R += 64;
        }
        (R !== O || P === 2) && h("JPEG_QUANTIZATION");
      } else if (S === 196) {
        let R = c + 2;
        for (; R < O; ) {
          R + 17 > O && h("JPEG_HUFFMAN");
          const C = o[R++], F = C >> 4, H = C & 15;
          (F > 1 || H > 3) && h("JPEG_HUFFMAN");
          let w = 0, M = 1;
          for (let X = 0; X < 16; X++) {
            const et = o[R++];
            w += et, M = M * 2 - et, M < 0 && h("JPEG_HUFFMAN");
          }
          (w < 1 || w > 256 || R + w > O) && h("JPEG_HUFFMAN"), A.add(F + ":" + H), R += w;
        }
        (R !== O || P === 2) && h("JPEG_HUFFMAN");
      } else if (S === 221)
        P !== 4 && h("JPEG_RESTART"), m = s.getUint16(c + 2);
      else if (S === 218) {
        (!D || ++I > 128) && h("JPEG_SCAN");
        const R = o[c + 2];
        (R < 1 || R > D.size || P !== 6 + 2 * R) && h("JPEG_SCAN");
        const C = /* @__PURE__ */ new Set();
        let F = -1;
        const H = o[O - 3], w = o[O - 2], M = o[O - 1] >> 4, X = o[O - 1] & 15;
        u === 192 && (H !== 0 || w !== 63 || M !== 0 || X !== 0) && h("JPEG_SCAN"), u === 194 && (H > w || w > 63 || H === 0 && w !== 0 || H > 0 && R !== 1 || M > 13 || X > 13 || M !== 0 && M !== X + 1) && h("JPEG_SCAN");
        const et = [...D.keys()];
        for (let V = 0; V < R; V++) {
          const at = c + 3 + 2 * V, At = o[at], dt = o[at + 1], bt = dt >> 4, Pt = dt & 15, Ct = et.indexOf(At);
          (Ct < 0 || Ct <= F || C.has(At) || bt > 3 || Pt > 3 || !y.has(D.get(At))) && h("JPEG_SCAN"), F = Ct, C.add(At), ((u === 192 || H === 0 && M === 0) && !A.has("0:" + bt) || (u === 192 || H > 0) && !A.has("1:" + Pt)) && h("JPEG_HUFFMAN");
        }
        c = O;
        let nt = 0, gt = 0;
        for (; c < o.length; ) {
          if (o[c] !== 255) {
            c++, nt++;
            continue;
          }
          const V = c++;
          for (_(c, 1); o[c] === 255; )
            c++, _(c, 1);
          const at = o[c];
          if (at === 0) {
            c !== V + 1 && h("JPEG_SCAN"), c++, nt++;
            continue;
          }
          if (at >= 208 && at <= 215) {
            (!m || at !== 208 + gt || !nt) && h("JPEG_RESTART"), gt = (gt + 1) % 8, c++;
            continue;
          }
          c = V;
          break;
        }
        nt || h("JPEG_EMPTY_SCAN");
        continue;
      } else S >= 224 && S <= 239 || S === 254 || h("JPEG_UNSUPPORTED");
      c = O;
    }
    E || h("JPEG_TRAILER"), b = 1;
  } else {
    _(0, 8), o.subarray(0, 8).some((A, S) => A !== [137, 80, 78, 71, 13, 10, 26, 10][S]) && h("RASTER_MAGIC");
    let c = 8, u = !1, D = !1, E = !1, I = !1, m = !1, y;
    for (; c < o.length; ) {
      _(c, 12);
      const A = s.getUint32(c), S = String.fromCharCode(...o.subarray(c + 4, c + 8));
      if ((!/^[A-Za-z]{2}[A-Z][A-Za-z]$/.test(S) || A > ne) && h("PNG_CHUNK"), _(c, A + 12), fr(o.subarray(c + 4, c + 8 + A)) !== s.getUint32(c + 8 + A) && h("PNG_CRC"), ["acTL", "fcTL", "fdAT"].includes(S) && h("APNG_UNSUPPORTED"), !u && S !== "IHDR" && h("PNG_ORDER"), S === "IHDR") {
        (u || A !== 13) && h("PNG_IHDR"), u = !0, p = s.getUint32(c + 8), d = s.getUint32(c + 12), ee(p, d), g = p * d, g > Oe && h("RASTER_PIXEL_BUDGET");
        const P = o[c + 16], O = o[c + 17];
        (!{ 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] }[O]?.includes(P) || o[c + 18] !== 0 || o[c + 19] !== 0 || o[c + 20] > 1) && h("PNG_IHDR");
      } else if (S === "PLTE")
        (m || D || [0, 4].includes(y) || !A || A % 3 || A > 768) && h("PNG_PALETTE"), m = !0;
      else if (S === "IDAT")
        (E || !A || y === 3 && !m) && h("PNG_IDAT"), D = !0;
      else if (S === "IEND") {
        (!D || A !== 0) && h("PNG_IEND"), I = !0, c += 12;
        break;
      } else
        D && (E = !0), S[0] === S[0].toUpperCase() && h("PNG_UNKNOWN_CRITICAL");
      S === "IHDR" && (y = o[c + 17]), c += A + 12;
    }
    (!I || c !== o.length) && h("PNG_TRAILER"), b = 1;
  }
  return { bytes: o, mime: "image/" + e[1], width: p, height: d, frames: b, frameRectanglePixels: g };
}
function mr(n) {
  const e = /* @__PURE__ */ new Map(), i = /* @__PURE__ */ new Set();
  let o = !1, s = 0, p = 0;
  const d = n.setTimeout?.bind(n) || setTimeout, b = n.clearTimeout?.bind(n) || clearTimeout, g = 256, _ = 64 * 1024 * 1024, c = 1e4, u = (m) => {
    m.settled || (m.settled = !0, s--, p -= m.bytes);
  }, D = (m) => {
    m.released || (m.released = !0, u(m), m.timer !== void 0 && b(m.timer), i.delete(m), m.image.onload = null, m.image.onerror = null, m.image.removeAttribute("src"), n.URL.revokeObjectURL(m.url));
  }, E = (m) => {
    if (!(m.released || m.retired)) {
      if (m.retired = !0, m.settled) {
        D(m);
        return;
      }
      i.add(m), m.timer = d(() => D(m), c);
    }
  }, I = (m) => {
    const y = e.get(m) || [];
    e.delete(m);
    for (const A of y) E(A);
  };
  return Object.freeze({ show(m, y, A, S = m) {
    o && h("CLOSED");
    const P = ur(cr(S, y, A));
    (s >= g || p + P.bytes.length > _) && h("RASTER_RESOURCE_BUSY");
    const O = n.document.createElement("img"), R = n.URL.createObjectURL(new n.Blob([P.bytes], { type: P.mime })), C = { url: R, image: O, bytes: P.bytes.length, settled: !1, retired: !1, released: !1, timer: void 0 };
    s++, p += C.bytes, O.alt = "figure";
    const F = (w) => {
      if (!C.released) {
        if (u(C), C.retired) {
          D(C);
          return;
        }
        if (!w) {
          D(C);
          const M = n.document.createElement("span");
          M.textContent = "Image unavailable: RASTER_DECODE", O.replaceWith(M);
        }
      }
    };
    O.onerror = () => F(!1), O.onload = () => F(O.naturalWidth === P.width && O.naturalHeight === P.height);
    const H = e.get(m) || [];
    return H.push(C), e.set(m, H), O.src = R, O;
  }, revoke: I, clear() {
    for (const m of [...e.keys()]) I(m);
  }, close() {
    if (!o) {
      o = !0;
      for (const m of [...e.keys()]) I(m);
    }
  } });
}
export {
  vo as QUESTION_HTML_PURIFIER_VERSION,
  mr as createPublicRasterDisplay,
  pr as createQuestionHtmlSanitizer
};
