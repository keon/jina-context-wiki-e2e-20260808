import assert from "node:assert/strict";
import { gridContracts, type GridContract } from "./css-contract.ts";

/**
 * Grid-track assertions, bound to whichever stylesheets a caller's markup is
 * actually dressed by.
 *
 * `gridContracts` was already parameterised by stylesheet path; only the list of
 * paths was app-specific, so that is the one thing the factory takes. A package
 * component's `*.module.css` is as valid an input as an app stylesheet — the
 * test loader maps a module class to its own name, so the class the markup
 * carries is the class the rule declares.
 */

export interface GridAssertions {
  assertGridContracts: (container: HTMLElement, subject: string) => void;
  assertGridRow: (container: HTMLElement, className: string, expected?: number) => void;
}

function elementChildren(element: Element): Element[] {
  return Array.from(element.children);
}

function describe(element: Element): string {
  return `<${element.tagName.toLowerCase()} class="${element.getAttribute("class") ?? ""}">`;
}

export function gridAssertions(stylesheets: readonly string[]): GridAssertions {
  const contractFor = (className: string): GridContract | undefined => {
    for (const stylesheet of stylesheets) {
      const contract = gridContracts(stylesheet).get(className);
      if (contract) return contract;
    }
    return undefined;
  };

  /**
   * The general sweep: for every element in the render whose class declares a
   * fixed column track list, the items it emits must fill whole rows.
   *
   * Deliberately the weak form of the contract — a positive multiple, not an
   * exact match — because it is applied blind to every grid a component happens
   * to render, and some of them (a `<dl>` of term/value pairs) legitimately run
   * to several rows. It is still what would have caught `.codex-step`: one child
   * in a three-track grid leaves two lanes empty and squeezes the content into
   * the first. Where the grid really is a single row, pin it with
   * `assertGridRow`.
   *
   * Counts element children only. Generated content (`::before`) is also a grid
   * item, so a class that relies on one has a row of `tracks - 1` children; none
   * of the fixed-track grids here do, and a stylesheet that grows one will say
   * so by failing this rather than by silently drifting.
   */
  const assertGridContracts = (container: HTMLElement, subject: string): void => {
    const offences: string[] = [];
    const elements = [container, ...Array.from(container.querySelectorAll("*"))];
    for (const element of elements) {
      for (const className of Array.from(element.classList)) {
        const contract = contractFor(className);
        if (!contract) continue;
        const children = elementChildren(element).length;
        if (children > 0 && children % contract.tracks === 0) continue;
        offences.push(
          `.${className} declares ${contract.tracks} tracks (${contract.declaration}) but ${describe(element)} emits ${children} children`
        );
      }
    }
    assert.deepEqual(offences, [], `${subject} broke a grid track contract:\n  ${offences.join("\n  ")}`);
  };

  /**
   * The exact form, for a class whose layout is one row of named lanes: every
   * element carrying it must emit exactly one child per track. This is the
   * assertion `.trail__row` needed — four children in a two-track grid fills two
   * rows, so the weak sweep above reads it as well-formed while the page shows
   * every step folded in half.
   */
  const assertGridRow = (container: HTMLElement, className: string, expected?: number): void => {
    const contract = contractFor(className);
    assert.ok(
      contract,
      `.${className} declares no fixed grid-template-columns; the row contract cannot be derived from the stylesheet`
    );
    if (expected !== undefined) {
      assert.equal(
        contract.tracks,
        expected,
        `.${className} is laid out as ${contract.tracks} lanes (${contract.declaration}); the component under test emits ${expected}`
      );
    }
    const elements = Array.from(container.querySelectorAll<HTMLElement>(`.${className}`));
    assert.ok(elements.length > 0, `no .${className} was rendered, so its row contract was not exercised`);
    for (const element of elements) {
      assert.equal(
        elementChildren(element).length,
        contract.tracks,
        `.${className} cuts ${contract.tracks} lanes (${contract.declaration}) but ${describe(element)} emits ${elementChildren(element).length} children`
      );
    }
  };

  return { assertGridContracts, assertGridRow };
}
