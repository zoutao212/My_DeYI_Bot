import { describe, it, expect } from 'vitest';
import { resolveAgentLayer } from './layer-resolver.js';

describe('resolveAgentLayer', () => {
  describe('配置优先级', () => {
    it('should return layer from config when provided', () => {
      expect(resolveAgentLayer('any-key', { agentLayer: 'virtual-world' }))
        .toBe('virtual-world');
      expect(resolveAgentLayer('any-key', { agentLayer: 'butler' }))
        .toBe('butler');
      expect(resolveAgentLayer('any-key', { agentLayer: 'execution' }))
        .toBe('execution');
    });
    
    it('should prioritize config over sessionKey', () => {
      // 即使 sessionKey 有前缀，配置也应该优先
      expect(resolveAgentLayer('virtual-world:lisi', { agentLayer: 'execution' }))
        .toBe('execution');
      expect(resolveAgentLayer('butler:lina', { agentLayer: 'virtual-world' }))
        .toBe('virtual-world');
    });
    
    it('should ignore invalid config values', () => {
      // 无效的配置值应该被忽略，继续使用 sessionKey 判断
      expect(resolveAgentLayer('virtual-world:lisi', { agentLayer: 'invalid' }))
        .toBe('virtual-world');
      expect(resolveAgentLayer('default-session', { agentLayer: 'invalid' }))
        .toBe('execution');
    });
  });
  
  describe('sessionKey 前缀判断', () => {
    it('should return virtual-world for virtual-world: prefix', () => {
      expect(resolveAgentLayer('virtual-world:lisi', {}))
        .toBe('virtual-world');
      expect(resolveAgentLayer('virtual-world:character1'))
        .toBe('virtual-world');
    });
    
    it('should return butler for butler: prefix', () => {
      expect(resolveAgentLayer('butler:lina', {}))
        .toBe('butler');
      expect(resolveAgentLayer('butler:assistant'))
        .toBe('butler');
    });
  });
  
  describe('默认行为', () => {
    it('should return execution by default', () => {
      expect(resolveAgentLayer('default-session', {}))
        .toBe('execution');
      expect(resolveAgentLayer('any-other-key'))
        .toBe('execution');
      expect(resolveAgentLayer(''))
        .toBe('execution');
    });
    
    it('should return execution for unknown prefixes', () => {
      expect(resolveAgentLayer('unknown:prefix'))
        .toBe('execution');
      expect(resolveAgentLayer('execution:explicit'))
        .toBe('execution');
    });
  });
  
  describe('边界情况', () => {
    it('should handle undefined config', () => {
      expect(resolveAgentLayer('virtual-world:lisi', undefined))
        .toBe('virtual-world');
      expect(resolveAgentLayer('default-session', undefined))
        .toBe('execution');
    });
    
    it('should handle empty config', () => {
      expect(resolveAgentLayer('butler:lina', {}))
        .toBe('butler');
    });
    
    it('should handle config with other properties', () => {
      expect(resolveAgentLayer('virtual-world:lisi', { 
        agentLayer: 'butler',
        otherProp: 'value' 
      })).toBe('butler');
    });
  });
});
