/**
 * Ported from the legacy player's sunapi/XmlParser — pure XML-string-in,
 * JS-value-out parsing helpers for two SUNAPI response shapes:
 *
 *  - the "CGI section" (`GET /stw-cgi/attributes.cgi/cgis`), a schema
 *    describing every CGI/submenu/action/parameter and its expected data
 *    type (`parseCgiSection`), and
 *  - the "attribute section" (`GET /stw-cgi/attributes.cgi/attributes`), the
 *    device's actual capability-flag values, optionally split per channel
 *    (`parseAttributeSection`/`parseAttributeSectionByChannel`).
 *
 * Legacy built this on jQuery (`$.parseXML` + `.find()`/`.filter()`/`.attr()`/
 * `.children()`/`.each()`/`.not()`). This port drops jQuery entirely in favor
 * of native `DOMParser` + `Element.querySelector`/`querySelectorAll` — the
 * attribute-name selectors legacy used (e.g. `"cgi[name='x']"`) are valid CSS
 * attribute selectors and translate directly.
 *
 * Legacy cached the last-parsed XML `Document` in module-level closure
 * variables (`AttributeSectionXML`/`ParsedAttributeSection` and
 * `CgiSectionXML`/`ParsedCgiSection`) so repeated calls with the same input
 * string skip re-parsing. That cache is preserved here, but as private
 * instance fields on a class (matching `SunapiManager`'s class-based style)
 * instead of legacy's factory-function/`Constructor.prototype` closure style.
 * Note the attribute-section cache fields are shared between
 * `parseAttributeSection` and `parseAttributeSectionByChannel` in legacy (both
 * read/write the same two module vars) — preserved here by having both
 * methods go through the same `getAttributeSectionDoc()` helper/fields, so a
 * call to either one can serve as the other's cache hit.
 */

/** Result shape for `parseCgiSection` — mirrors legacy's `stringToJsonCGIs` return shapes. */
export type CgiParameterValue = (Record<string, unknown> & { isRequest?: boolean }) | (string | null)[] | boolean;

/** Result shape for `parseAttributeSection`/`parseAttributeSectionByChannel` — mirrors legacy's `stringToJsonAttributes`. */
export type AttributeValue = boolean | number | string[] | undefined;

export interface ParseCgiSectionOptions {
  parseRequest?: boolean;
}

export class XmlParser {
  private cgiSectionXML: string | undefined;
  private parsedCgiSection: Document | undefined;

  private attributeSectionXML: string | undefined;
  private parsedAttributeSection: Document | undefined;

  private getCgiSectionDoc(iXML: string): Document {
    if (this.cgiSectionXML === undefined || this.cgiSectionXML !== iXML) {
      this.cgiSectionXML = iXML;
      this.parsedCgiSection = new DOMParser().parseFromString(iXML, 'application/xml');
    }
    return this.parsedCgiSection!;
  }

  private getAttributeSectionDoc(iXML: string): Document {
    if (this.attributeSectionXML === undefined || this.attributeSectionXML !== iXML) {
      this.attributeSectionXML = iXML;
      this.parsedAttributeSection = new DOMParser().parseFromString(iXML, 'application/xml');
    }
    return this.parsedAttributeSection!;
  }

  /**
   * Ported from legacy `stringToJsonCGIs`. `result` is expected to be a
   * `<parameter>` element (or similar) with a `<dataType>` child whose own
   * single child element names the type (`<string>`/`<int>`/`<float>`/
   * `<enum>`/`<csv>`/`<bool>`), e.g.:
   * `<parameter name="x"><dataType><int min="0" max="10"/></dataType></parameter>`.
   *
   * NOTE: legacy quirk preserved — if `result` has no `<dataType>` child at
   * all, this throws (matches legacy's `result.find('dataType')[0].childNodes[0]`,
   * which dereferences `[0]` of an empty jQuery set and throws the same way).
   */
  private stringToJsonCGIs(result: Element): CgiParameterValue {
    const dataTypeElement = result.querySelector('dataType')!;
    const dataTypeNode = dataTypeElement.childNodes[0];

    let dataType: string | undefined;
    if (dataTypeNode !== undefined) {
      dataType = dataTypeNode.nodeName;
    }

    let oValue: CgiParameterValue | undefined;

    if (dataType === 'string') {
      const node = dataTypeNode as unknown as Element;
      const value: Record<string, unknown> = {};
      if (node.getAttribute('minlen') !== null) {
        value.minLength = node.getAttribute('minlen');
      }
      if (node.getAttribute('maxlen') !== null) {
        value.maxLength = node.getAttribute('maxlen');
      }
      if (node.getAttribute('formatInfo')) {
        value.formatInfo = node.getAttribute('formatInfo');
      }
      if (node.getAttribute('format')) {
        value.format = node.getAttribute('format');
      }
      oValue = value;
    } else if (dataType === 'int' || dataType === 'float') {
      const node = dataTypeNode as unknown as Element;
      const value: Record<string, unknown> = {};
      const min = node.getAttribute('min');
      if (min !== null) {
        value.minValue = dataType === 'float' ? parseFloat(min) : parseInt(min, 10);
      }
      const max = node.getAttribute('max');
      if (max !== null) {
        value.maxValue = dataType === 'float' ? parseFloat(max) : parseInt(max, 10);
      }
      oValue = value;
    } else if (dataType === 'enum' || dataType === 'csv') {
      const entries = result.querySelectorAll('entry');
      const values: (string | null)[] = [];
      entries.forEach((entry) => values.push(entry.getAttribute('value')));
      oValue = values;
    } else if (dataType === 'bool') {
      oValue = true;
    }

    return oValue ?? {};
  }

  /**
   * Ported from legacy `stringToJsonAttributes`. `result` is expected to be
   * an `<attribute name="..." type="..." value="..."/>` element.
   *
   * NOTE: legacy only handles `type="bool"`/`"int"`/`"enum"`/`"csv"` —
   * `"string"`/`"float"` (and anything else) fall through and return
   * `undefined`. Preserved as-is: real attribute-section responses only use
   * bool/int/enum/csv for capability flags, so this was never hit in
   * practice, but it's still a real gap in legacy's coverage rather than an
   * intentional design choice — not "fixed" here since there is no test
   * device response exercising it to confirm what the right behavior would
   * even be.
   */
  private stringToJsonAttributes(result: Element | null): AttributeValue {
    if (!result) {
      return undefined;
    }

    const dataType = result.getAttribute('type');
    const iValue = result.getAttribute('value');

    if (dataType === 'bool') {
      return iValue === 'True';
    } else if (dataType === 'int') {
      return parseInt(iValue ?? '', 10);
    } else if (dataType === 'enum' || dataType === 'csv') {
      // legacy quirk preserved: throws if the `value` attribute is absent
      // (iValue === null), same as legacy's `iValue.split(',')` on `undefined`.
      return iValue!.split(',');
    }

    return undefined;
  }

  /**
   * Ported from legacy `parseCgiSection`.
   *
   * `iXML`: output from `GET /stw-cgi/attributes.cgi/cgis`.
   * `inputStr`: one of
   *   `cginame/submenu/action/parameter/datatype` (5 tokens),
   *   `cginame/submenu/parameter/datatype` (4 tokens),
   *   `submenu/parameter/datatype` (3 tokens), or
   *   `parameter/datatype` (2 tokens).
   * The trailing `datatype` token is ported for documentation of the
   * expected shape but — same as legacy — is never actually read; the
   * runtime data type is discovered from the `<dataType>` child instead (see
   * `stringToJsonCGIs`).
   */
  parseCgiSection(iXML: string, inputStr: string, options?: ParseCgiSectionOptions): CgiParameterValue | undefined {
    const doc = this.getCgiSectionDoc(iXML);
    const tokens = inputStr.split('/');

    let cgiName: string | undefined;
    let submenu: string | undefined;
    let action: string | undefined;
    let parameter: string | undefined;

    if (tokens.length === 5) {
      [cgiName, submenu, action, parameter] = tokens;
    } else if (tokens.length === 4) {
      [cgiName, submenu, parameter] = tokens;
    } else if (tokens.length === 3) {
      [submenu, parameter] = tokens;
    } else if (tokens.length === 2) {
      [parameter] = tokens;
    } else {
      // cannot found: return 'undefined'
      return undefined;
    }

    let current: ParentNode | null = doc;
    if (cgiName && current) {
      current = current.querySelector(`cgi[name='${cgiName}']`);
    }
    if (submenu && current) {
      current = current.querySelector(`submenu[name='${submenu}']`);
    }
    if (action && current) {
      current = current.querySelector(`action[name='${action}']`);
    }
    if (parameter && current) {
      current = current.querySelector(`parameter[name='${parameter}']`);
    }

    const scope = current instanceof Element ? current : null;
    if (!scope) {
      // Not found: return 'undefined'
      return undefined;
    }

    const json = this.stringToJsonCGIs(scope);
    if (options?.parseRequest) {
      const isRequest = scope.getAttribute('request') === 'true';
      if (typeof json === 'object' && json !== null) {
        (json as Record<string, unknown>).isRequest = isRequest;
      }
      // else: dataType 'bool' produced a primitive `true`/`false` — legacy's
      // sloppy-mode JS silently drops a property assignment on a primitive
      // (`json.isRequest = ...` on a boolean is a no-op there); this module
      // runs under ESM strict mode where that same assignment would throw
      // instead, so it's skipped here to preserve legacy's actual (silently
      // dropped) effect rather than crash on it.
    }
    return json;
  }

  /**
   * Ported from legacy `parseAttributeSectionByChannel`. Returns an array of
   * length `maxChannel`, indexed by channel number, with each populated slot
   * holding the parsed value of the `groupName/categoryName/.../attrName`
   * attribute for that channel (unset slots stay `undefined`, matching
   * legacy's sparse `Array(maxChannel)`).
   *
   * `maxChannel` is optional because several legacy call sites omit it
   * (`xmlParser.parseAttributeSectionByChannel(data, 'Media/Support/WiseStream')`,
   * no third argument) — matching legacy's own JS calling convention, where
   * `maxChannel` was simply `undefined` in that case. `new Array(undefined)`
   * behaves the same in both legacy and here: a single-element array (JS's
   * `Array(n)` only special-cases a *numeric* single argument as a length).
   */
  parseAttributeSectionByChannel(iXML: string, inputStr: string, maxChannel?: number): AttributeValue[] {
    const result: AttributeValue[] = new Array(maxChannel);
    const doc = this.getAttributeSectionDoc(iXML);
    if (!doc) {
      return result;
    }

    const tokens = inputStr.split('/');
    const targetIndex = tokens.length - 1;
    const groupName = tokens[0];
    const categoryName = tokens[1];
    const attrName = tokens[targetIndex];

    const setAttributeByChannel = (channelId: number, scope: Element | null): void => {
      const attribute = scope ? scope.querySelector(`attribute[name='${attrName}']`) : null;
      result[channelId] = this.stringToJsonAttributes(attribute);
    };

    const groupEl = doc.querySelector(`group[name='${groupName}']`);
    const category = groupEl ? groupEl.querySelector(`category[name='${categoryName}']`) : null;

    const channels = category ? Array.from(category.querySelectorAll('channel')) : [];
    if (channels.length === 0) {
      setAttributeByChannel(0, category);
    } else {
      for (const channelEl of channels) {
        const channelId = parseInt(channelEl.getAttribute('number') ?? '', 10);
        setAttributeByChannel(channelId, channelEl);
      }
    }

    return result;
  }

  /**
   * Ported from legacy `parseAttributeSection`.
   *
   * `iXML`: output from `GET /stw-cgi/attributes.cgi/attributes`.
   * `inputStr`: `groupName/categoryName/attributeName` (3 tokens),
   * `categoryName/attributeName` (2 tokens), or `attributeName` (1 token).
   */
  parseAttributeSection(iXML: string, inputStr: string): AttributeValue {
    const doc = this.getAttributeSectionDoc(iXML);

    const tokens = inputStr.split('/');
    let groupName: string | undefined;
    let categoryName: string | undefined;
    let attributeName: string | undefined;

    if (tokens.length === 3) {
      [groupName, categoryName, attributeName] = tokens;
    } else if (tokens.length === 2) {
      [categoryName, attributeName] = tokens;
    } else if (tokens.length === 1) {
      [attributeName] = tokens;
    }

    let scope: ParentNode | null = doc;
    if (groupName && scope) {
      scope = scope.querySelector(`group[name='${groupName}']`);
    }
    if (categoryName && scope) {
      scope = scope.querySelector(`category[name='${categoryName}']`);
    }

    let target: Element | null = null;
    if (attributeName && scope) {
      // has "attribute" node directly vs. only "channel" nodes: pick the
      // last match in the former case, the first in the latter — same as
      // legacy's `.children().not('channel')` / `.find(...).last()` vs `.first()`.
      const notChannels = Array.from(scope.children).filter((el) => el.tagName !== 'channel');
      const matches = Array.from(scope.querySelectorAll(`attribute[name='${attributeName}']`));
      target = (notChannels.length > 0 ? matches[matches.length - 1] : matches[0]) ?? null;
    } else if (scope instanceof Element) {
      target = scope;
    }

    if (!target) {
      // Not Found: return 'undefined'
      return undefined;
    }
    return this.stringToJsonAttributes(target);
  }
}
