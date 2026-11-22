import { describe, it, expect } from 'vitest';
import { groupKey, networkIdFromRequest, normalizeAddress } from './network';

describe('normalizeAddress', () => {
  it('去掉 IPv4-mapped IPv6 前缀', () => {
    expect(normalizeAddress('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(normalizeAddress('::FFFF:10.0.0.1')).toBe('10.0.0.1');
  });
});

describe('groupKey', () => {
  it('回环地址各自同组', () => {
    expect(groupKey('127.0.0.1')).toBe('loopback');
    expect(groupKey('::1')).toBe('loopback');
  });

  it('私网按 RFC1918 块边界归组', () => {
    expect(groupKey('10.1.2.3')).toBe(groupKey('10.9.8.7'));
    expect(groupKey('10.1.2.3')).toBe('lan:v4:10');
    expect(groupKey('172.16.5.5')).toBe(groupKey('172.31.4.4'));
    expect(groupKey('172.16.5.5')).toBe('lan:v4:172.16-31');
    expect(groupKey('192.168.1.10')).toBe(groupKey('192.168.2.10'));
    expect(groupKey('192.168.1.10')).toBe('lan:v4:192.168');
  });

  it('不同私网块互相隔离', () => {
    expect(groupKey('192.168.1.10')).not.toBe(groupKey('10.0.0.10'));
    expect(groupKey('10.0.0.10')).not.toBe(groupKey('172.16.0.10'));
  });

  it('公网地址按完整地址归组，172.32 与 192.0 不套用私网规则', () => {
    expect(groupKey('172.32.0.1')).toBe('wan:v4:172.32.0.1');
    expect(groupKey('192.0.2.10')).toBe('wan:v4:192.0.2.10');
    expect(groupKey('203.0.113.7')).toBe('wan:v4:203.0.113.7');
    expect(groupKey('203.0.113.7')).not.toBe(groupKey('198.51.100.3'));
  });

  it('IPv4-mapped IPv6 归一到同一网络', () => {
    expect(groupKey('::ffff:203.0.113.7')).toBe(groupKey('203.0.113.7'));
  });

  it('IPv6 ULA / 链路本地 / 公网分别归组', () => {
    expect(groupKey('fd00:1:2:3:4:5:6:7')).toBe(groupKey('fd00:1:2:3:9:9:9:9'));
    expect(groupKey('fd00:1:2:3:4:5:6:7')).toBe('lan:v6:fd00:1:2:3');
    expect(groupKey('fe80:1:2:3::')).toBe('lan:v6:link-local');
    expect(groupKey('2001:db8::1')).toBe('wan:v6:2001:db8::1');
  });

  it('拿不到来源地址时归入 direct 组', () => {
    expect(groupKey('')).toBe('direct');
    expect(groupKey('   ')).toBe('direct');
  });
});

describe('networkIdFromRequest', () => {
  it('Cloudflare 部署取 CF-Connecting-IP', () => {
    const headers = new Headers({ 'cf-connecting-ip': '203.0.113.7' });
    expect(networkIdFromRequest(headers)).toBe('wan:v4:203.0.113.7');
  });

  it('可信反代开启时取 X-Forwarded-For 首段', () => {
    const headers = new Headers({
      'cf-connecting-ip': '203.0.113.7',
      'x-forwarded-for': '198.51.100.3, 10.0.0.1',
    });
    expect(networkIdFromRequest(headers, true)).toBe('wan:v4:198.51.100.3');
    // 未开启信任时忽略该头，避免伪造
    expect(networkIdFromRequest(headers, false)).toBe('wan:v4:203.0.113.7');
  });

  it('直连部署没有来源头时归入 direct', () => {
    expect(networkIdFromRequest(new Headers())).toBe('direct');
  });
});
