'use strict'
const assert = require('assert')
const crypto = require('crypto')
const fs = require('fs'); const path = require('path')
const vc = require('./vscrypto.cjs')

// 1) нонс: длина и печатность
const n = vc.genNonce(31)
assert.strictEqual(n.length, 31)
assert.ok([...n].every(b => b >= 0x20 && b < 0x7f), 'нонс печатный ASCII')

// 2) вывод ключа: порядок конкатенации v1_buf ‖ v2rnd, оба алгоритма
const v1 = Buffer.from('0102030405', 'hex'); const v2 = Buffer.from('v2rndTEST', 'latin1')
assert.strictEqual(vc.deriveKey(v1, v2, 8).toString('hex'),
  crypto.createHash('sha256').update(Buffer.concat([v1, v2])).digest('hex'), 'SHA-256 key = H(v1‖v2)')
assert.strictEqual(vc.deriveKey(v1, v2, 4).toString('hex'),
  crypto.createHash('sha1').update(Buffer.concat([v1, v2])).digest('hex'), 'SHA-1 key')
assert.strictEqual(vc.deriveKey(v1, v2, 8).length, 32)

// 3) AES-128-ECB без IV: round-trip на блочно-выровненных данных
const sc = new vc.VSSymmetricCrypt().setCipher(1, 3).setKey(vc.deriveKey(v1, v2, 8))
const plain = Buffer.from('0123456789abcdef'.repeat(2), 'latin1') // 32Б = 2 блока
assert.ok(sc.decrypt(sc.encrypt(plain)).equals(plain), 'AES-ECB round-trip')

// 4) RSA из реального сертификата сервера (если фикстура на месте)
const certP = path.join(__dirname, '.server_cert.pem')
if (fs.existsSync(certP)) {
  const pem = fs.readFileSync(certP)
  const info = vc.certPublicKeyInfo(pem)
  assert.strictEqual(info.type, 'rsa', 'ключ сертификата — RSA')
  const enc = vc.rsaEncryptWithCert(pem, vc.genNonce(31))
  assert.strictEqual(enc.length, info.bits / 8, 'размер RSA-шифртекста = размеру ключа')
  console.log(`OK: нонс, вывод ключа, AES-ECB; RSA из серта (${info.type}-${info.bits}, subject ${info.subject.split('\n')[0]})`)
} else {
  console.log('OK: нонс, вывод ключа, AES-ECB; RSA пропущен (нет фикстуры серта)')
}

// 5) Обмен ключами (EVP_Seal-конверт): round-trip seal→open на своей RSA-паре
{
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
  const sealed = vc.sealKeyExchange(publicKey, { family: 1, keysize: 16 })
  // размеры кадра = как в захвате (332Б для AES-128)
  assert.strictEqual(sealed.frame.length, 332, 'кадр seal = 332Б (как в захвате)')
  assert.strictEqual(sealed.frame.readUInt32LE(0), 328, 'flen=328')
  assert.strictEqual(sealed.frame.readUInt32LE(4), 1, 'type=1')
  assert.strictEqual(sealed.frame.readUInt32LE(8), 256, 'rsaLen=256')
  const opened = vc.openKeyExchange(privateKey, sealed.frame)
  assert.strictEqual(opened.family, 1); assert.strictEqual(opened.keysize, 16)
  assert.ok(opened.key1.equals(sealed.key1), 'key1 восстановлен через open')
  assert.ok(opened.key2.equals(sealed.key2), 'key2 восстановлен через open')
  console.log('OK: EVP_Seal-конверт — round-trip seal→open, кадр 332Б, два сессионных ключа восстановлены')
}
