import { test } from 'node:test'
import assert from 'node:assert/strict'
import { configSchema, secretMatches } from '../src/config'
import { defaultConfig } from '../src/types'
import { imageType, imageUrl, publicIPv4 } from '../src/images'
test('configuration rejects duplicate listeners and incomplete active bindings', () => {
  assert.equal(configSchema.parse(defaultConfig).accounts.length, 2)
  assert.equal(configSchema.parse(defaultConfig).mergeWindowSeconds, 20)
  assert.equal(configSchema.parse({ ...defaultConfig, mergeWindowSeconds:0 }).mergeWindowSeconds, 0)
  for (const seconds of [-1,61,NaN,'20']) assert.throws(() => configSchema.parse({ ...defaultConfig, mergeWindowSeconds:seconds }))
  assert.throws(() => configSchema.parse({ ...defaultConfig, accounts: [{ ...defaultConfig.accounts[0], enabled: true }] }))
  assert.throws(() => configSchema.parse({ ...defaultConfig, accounts: [defaultConfig.accounts[0], defaultConfig.accounts[0]] }))
  assert.equal(secretMatches('a', 'b'), false)
  assert.equal(secretMatches('abc', 'abc'), true)
  assert.equal(secretMatches('', ''), false)
})
test('images reject local paths, private hosts, untrusted URLs and corrupt signatures', () => {
  for (const url of ['file:///C:/secret.png','http://127.0.0.1/a','https://example.com/a','https://qpic.cn.evil.test/a','https://a:b@qpic.cn/a','https://multimedia.nt.qq.com.cn.evil.test/a']) assert.throws(() => imageUrl(url))
  assert.equal(imageUrl('https://multimedia.nt.qq.com/a?key=secret').hostname, 'multimedia.nt.qq.com')
  assert.equal(imageUrl('https://multimedia.nt.qq.com.cn/download?appid=1406').hostname, 'multimedia.nt.qq.com.cn')
  for (const ip of ['127.0.0.1','10.1.1.1','192.168.1.1','169.254.169.254','172.31.1.1','100.64.0.1','0.0.0.0','::1']) assert.equal(publicIPv4(ip), false)
  assert.equal(publicIPv4('8.8.8.8'), true)
  assert.throws(() => imageType(Buffer.from('not-image')))
})
