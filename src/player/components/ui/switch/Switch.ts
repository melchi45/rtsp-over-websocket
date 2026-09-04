/**
 * A standalone, reusable toggle-switch factory -- see
 * `docs/player/10-onvif-metadata-overlay.md` for the full reference and
 * `docs/DESIGN.md` §2.7 for why this isn't markup progressively enhanced in
 * place (unlike `wisenet-camera-discovery`'s `mountSwitch()`): this
 * element's context menu has no pre-existing static HTML to enhance, it's
 * all built imperatively.
 *
 * Visual style (`.ui-switch*` classes, defined in `elements/panelStyles.ts`)
 * deliberately targets `wisenet-camera-discovery`'s
 * `mountSwitch({variant: 'slider'})` dark-theme appearance, not this
 * element's own pre-existing (differently-sized/colored) Audio mute toggle
 * -- see that doc for the exact values and why.
 */

export interface SwitchOptions {
  initialValue: boolean;
  onChange?: (value: boolean) => void;
  ariaLabel?: string;
}

export interface SwitchController {
  /** Mount this wherever the caller needs the toggle to appear. */
  element: HTMLElement;
  getValue(): boolean;
  /** Sets state directly; does NOT fire onChange -- same convention as
   *  assigning a native <input>'s `.checked` property, which also never
   *  fires 'change'. */
  setValue(value: boolean): void;
  /** Removes the click listener. Does not itself remove `element` from the
   *  DOM (the caller owns where it was mounted), only detaches it if it's
   *  still attached to a parent at the time of the call. */
  destroy(): void;
}

export function createSwitch(options: SwitchOptions): SwitchController {
  let value = options.initialValue;

  const element = document.createElement('span');
  element.className = 'ui-switch';
  element.setAttribute('role', 'switch');
  element.setAttribute('tabindex', '0');
  if (options.ariaLabel !== undefined) {
    element.setAttribute('aria-label', options.ariaLabel);
  }

  const track = document.createElement('span');
  track.className = 'ui-switch-track';
  const thumb = document.createElement('span');
  thumb.className = 'ui-switch-thumb';
  track.appendChild(thumb);
  element.appendChild(track);

  function applyVisualState(): void {
    element.classList.toggle('on', value);
    element.setAttribute('aria-checked', String(value));
  }
  applyVisualState();

  function handleActivate(): void {
    value = !value;
    applyVisualState();
    options.onChange?.(value);
  }

  function handleClick(): void {
    handleActivate();
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault();
      handleActivate();
    }
  }

  element.addEventListener('click', handleClick);
  element.addEventListener('keydown', handleKeydown);

  return {
    element,
    getValue: () => value,
    setValue: (newValue: boolean) => {
      value = newValue;
      applyVisualState();
    },
    destroy: () => {
      element.removeEventListener('click', handleClick);
      element.removeEventListener('keydown', handleKeydown);
      element.parentElement?.removeChild(element);
    }
  };
}
