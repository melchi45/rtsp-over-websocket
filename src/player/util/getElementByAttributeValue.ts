export function getElementByAttributeValue(elementType: string, attribute: string, value: unknown): Element | undefined {
  const type = elementType || '*';
  const all = document.getElementsByTagName(type);
  for (let i = 0; i < all.length; i++) {
    if (value !== undefined && all[i].getAttribute(attribute) == value) {
      return all[i];
    }
  }
  return undefined;
}
