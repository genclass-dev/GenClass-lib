// Applies the RelationshipProvider fix to the file the admin really loads: @payloadcms/ui's bundled, minified client
// entry (dist/exports/client/index.js carries its own copy of every component; dist/elements/** is not what Next
// compiles). The same changes as the TSX patch, on the minified names. `--revert` restores the backup.
import { readFileSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
const app = process.env.PAYLOAD_APP ?? process.cwd(); // the Payload app (create-payload-app) directory
const file = `${app}/node_modules/@payloadcms/ui/dist/exports/client/index.js`;
const backup = `${file}.orig`;
if (process.argv.includes("--revert")) {
  copyFileSync(backup, file);
  console.log("reverted");
  process.exit(0);
}
if (!existsSync(backup)) copyFileSync(file, backup);
let s = readFileSync(backup, "utf8");
const rep = (from, to) => {
  const n = s.split(from).length - 1;
  if (n !== 1) throw new Error(`anchor found ${n} times: ${from.slice(0, 70)}`);
  s = s.replace(from, to);
};
// 1. the in-flight ids per collection (with the batch that owns each) and the latest documents, kept current by an
//    effect declared before the loader's effect (two refs and an effect, after the locale ref)
rep(`{code:f}=we(),m=NV(f),p;e[1]!==u||e[2]!==a||e[3]!==i||e[4]!==d||e[5]!==f?(p=w=>{`, `{code:f}=we(),m=NV(f),gcIF=NV({}),gcLD=NV(n),p;EV(()=>{gcLD.current=n},[n]);e[1]!==u||e[2]!==a||e[3]!==i||e[4]!==d||e[5]!==f?(p=w=>{`);
// 2. leave out the ids in flight and the ids the latest documents no longer have as null (reloadAll takes everything)
rep(`let[I,S]=x,F=[];if(Object.entries(S).forEach(D=>{let[_,T]=D;(T===null||R)&&F.push(_)}),F.length>0){`, `let[I,S]=x,F=[],gcMap=gcIF.current[I]??new Map;gcIF.current[I]=gcMap;if(Object.entries(S).forEach(D=>{let[_,T]=D;(T===null&&gcLD.current[I]?.[_]===null&&!gcMap.has(_)||R)&&F.push(_)}),F.length>0){`);
// 3. mark the ids with this batch before the request; a request that throws is logged; release this batch's own ids
rep(
  `let E=\`?\${_.toString()}&\${fD.stringify({select:T})}\`,L=await fetch(\`\${D}\${E}\`,{credentials:"include",headers:{"Accept-Language":d.language}});if(L.ok){let $=await L.json();$.docs&&s({type:"ADD_LOADED",docs:$.docs,idsToLoad:F,relationTo:I})}else s({type:"ADD_LOADED",docs:[],idsToLoad:F,relationTo:I})}})}`,
  `let E=\`?\${_.toString()}&\${fD.stringify({select:T})}\`,gcB={};k.forEach(q=>gcMap.set(q,gcB));try{let L=await fetch(\`\${D}\${E}\`,{credentials:"include",headers:{"Accept-Language":d.language}});if(L.ok){let $=await L.json();$.docs&&s({type:"ADD_LOADED",docs:$.docs,idsToLoad:F,relationTo:I})}else s({type:"ADD_LOADED",docs:[],idsToLoad:F,relationTo:I})}catch(gcE){console.error("Error loading relationship documents",gcE)}k.forEach(q=>{gcMap.get(q)===gcB&&gcMap.delete(q)})}})}`,
);
writeFileSync(file, s);
console.log("applied to the client bundle");
