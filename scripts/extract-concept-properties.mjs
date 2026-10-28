import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const sourcePath = resolve(root, 'backup/1022-project/web/data/standard.json');
const hierarchyPath = resolve(root, 'data/concepts/concept-hierarchy.json');
const outputPath = resolve(root, 'data/concepts/concept-properties.json');

if (!existsSync(sourcePath)) throw new Error('未找到属性来源：' + sourcePath);

const hierarchy = JSON.parse(readFileSync(hierarchyPath, 'utf8'));
const source = JSON.parse(readFileSync(sourcePath, 'utf8'));
const names = new Set();
const collect = (nodes = []) => nodes.forEach((node) => {
  names.add(node.名称);
  collect(node.子项);
});
collect(hierarchy.层级);

const 概念属性 = {};
for (const record of source.约束记录 ?? []) {
  if (!names.has(record.概念名称) || !Array.isArray(record.参考参数) || record.参考参数.length === 0) continue;
  概念属性[record.概念名称] = record.参考参数.map(({ 名称, 取值, 单位, 工况或侧别, 型号上下文, 来源 }) => ({
    名称,
    取值,
    ...(单位 ? { 单位 } : {}),
    ...(工况或侧别 ? { 工况或侧别 } : {}),
    ...(型号上下文 ? { 型号上下文 } : {}),
    ...(来源?.length ? { 来源 } : {}),
  }));
}

const output = {
  schema_version: 'concept-properties-v1',
  说明: '从 backup/1022-project 的标准与参考参数中抽取。数值属于资料实例或参考设计，使用时应结合型号上下文和来源核对。',
  属性概念数: Object.keys(概念属性).length,
  概念属性,
};
writeFileSync(outputPath, JSON.stringify(output, null, 2) + '\n');
console.log('已提取 ' + output.属性概念数 + ' 个概念的关键属性到 ' + outputPath);
