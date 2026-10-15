/** 把真实提示词 dump 出来，验证「风格注入」到底给了模型什么。 */
import { readFileSync } from 'node:fs'
import { buildWriterPacket, renderWriterPacket } from '../server/projection.js'

const pid = process.argv[2] || 'p_737e9cf5455f'
const no = Number(process.argv[3] || 7)
const p = JSON.parse(readFileSync(new URL(`../data/projects/${pid}.json`, import.meta.url), 'utf8'))

const packet = buildWriterPacket(p, no, { wordCount: 2600 })
console.log('-------- 【文风规则】段（提示词真正注入的风格指令）--------')
console.log(JSON.stringify(packet.style, null, 2))
console.log('\n-------- 渲染后的完整提示词（前 2600 字）--------')
console.log(renderWriterPacket(packet).slice(0, 2600))
