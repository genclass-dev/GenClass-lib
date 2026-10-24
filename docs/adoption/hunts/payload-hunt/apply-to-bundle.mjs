// Applies the RelationshipProvider fix to the file the admin really loads: @payloadcms/ui's bundled, minified client
// entry (dist/exports/client/index.js carries its own copy of every component; dist/elements/** is not what Next
// compiles). The same three changes as the TSX patch, on the minified names. `--revert` restores the backup.
import { readFileSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
const app = process.env.PAYLOAD_APP ?? "/home/user/payload-hunt/app";
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
// 1. a ref of the ids in flight, per collection (one more hook, in a fixed position after the locale ref)
rep(`{code:f}=we(),m=NV(f),p;e[1]!==u||e[2]!==a||e[3]!==i||e[4]!==d||e[5]!==f?(p=w=>{`, `{code:f}=we(),m=NV(f),gcIF=NV({}),p;e[1]!==u||e[2]!==a||e[3]!==i||e[4]!==d||e[5]!==f?(p=w=>{`);
// 2. leave the pending ids out of the batch (reloadAll still takes everything)
rep(`let[I,S]=x,F=[];if(Object.entries(S).forEach(D=>{let[_,T]=D;(T===null||R)&&F.push(_)}),F.length>0){`, `let[I,S]=x,F=[],gcSet=gcIF.current[I]??=new Set;if(Object.entries(S).forEach(D=>{let[_,T]=D;(T===null&&!gcSet.has(_)||R)&&F.push(_)}),F.length>0){`);
// 3. mark the ids before the request, unmark them when it is over
rep(
  `let E=\`?\${_.toString()}&\${fD.stringify({select:T})}\`,L=await fetch(\`\${D}\${E}\`,{credentials:"include",headers:{"Accept-Language":d.language}});if(L.ok){let $=await L.json();$.docs&&s({type:"ADD_LOADED",docs:$.docs,idsToLoad:F,relationTo:I})}else s({type:"ADD_LOADED",docs:[],idsToLoad:F,relationTo:I})}})}`,
  `let E=\`?\${_.toString()}&\${fD.stringify({select:T})}\`;k.forEach(q=>gcSet.add(q));try{let L=await fetch(\`\${D}\${E}\`,{credentials:"include",headers:{"Accept-Language":d.language}});if(L.ok){let $=await L.json();$.docs&&s({type:"ADD_LOADED",docs:$.docs,idsToLoad:F,relationTo:I})}else s({type:"ADD_LOADED",docs:[],idsToLoad:F,relationTo:I})}finally{k.forEach(q=>gcSet.delete(q))}}})}`,
);
writeFileSync(file, s);
console.log("applied to the client bundle");
