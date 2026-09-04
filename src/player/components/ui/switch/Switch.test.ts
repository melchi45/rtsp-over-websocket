// @vitest-environment jsdom
// DOM construction/interaction requires a real `document` -- see
// `network/http/XmlParser.test.ts` for the same per-file environment
// override pattern (this project's vitest.config.ts default is 'node').
import { describe, expect, it, vi } from 'vitest';
import { createSwitch } from './Switch';

describe('createSwitch', () => {
  it('builds a track+thumb structure and reflects initialValue', () => {
    const { element, getValue } = createSwitch({ initialValue: true });

    expect(element.classList.contains('ui-switch')).toBe(true);
    expect(element.classList.contains('on')).toBe(true);
    expect(element.getAttribute('aria-checked')).toBe('true');
    expect(element.querySelector('.ui-switch-track')).not.toBeNull();
    expect(element.querySelector('.ui-switch-thumb')).not.toBeNull();
    expect(getValue()).toBe(true);
  });

  it('flips value and fires onChange on click', () => {
    const onChange = vi.fn();
    const { element, getValue } = createSwitch({ initialValue: false, onChange });

    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(getValue()).toBe(true);
    expect(element.classList.contains('on')).toBe(true);
    expect(onChange).toHaveBeenCalledExactlyOnceWith(true);

    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(getValue()).toBe(false);
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenLastCalledWith(false);
  });

  it('flips value on Space/Enter keydown', () => {
    const onChange = vi.fn();
    const { element, getValue } = createSwitch({ initialValue: false, onChange });

    element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(getValue()).toBe(true);

    element.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }));
    expect(getValue()).toBe(false);
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('setValue updates state without firing onChange', () => {
    const onChange = vi.fn();
    const { getValue, setValue } = createSwitch({ initialValue: false, onChange });

    setValue(true);

    expect(getValue()).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('destroy removes listeners (a click after destroy no longer changes state) and detaches from its parent', () => {
    const onChange = vi.fn();
    const { element, getValue, destroy } = createSwitch({ initialValue: false, onChange });
    const parent = document.createElement('div');
    parent.appendChild(element);

    destroy();

    expect(parent.contains(element)).toBe(false);
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(getValue()).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
  });
});
