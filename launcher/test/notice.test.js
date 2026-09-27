'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { parseNotice } = require('../../tools/publish-notice')

test('공지 글: 앞뒤 공백·BOM 정리, ! 로 시작하면 강조, 비우면 내림', () => {
  assert.deepEqual(parseNotice('﻿오늘 밤 9시 보스 레이드!\r\n모두 모여요  \r\n'), { text: '오늘 밤 9시 보스 레이드!\n모두 모여요', level: 'info' })
  assert.deepEqual(parseNotice('!서버 점검 중 (10시까지)'), { text: '서버 점검 중 (10시까지)', level: 'warn' })
  assert.deepEqual(parseNotice('   \r\n'), { text: '', level: 'info' })
})
