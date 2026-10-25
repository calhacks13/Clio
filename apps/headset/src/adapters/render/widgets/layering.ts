import { Group } from 'three';
import { ON_TOP_ORDER } from '../on-top';

// Widgets are panels beside the step card, so they draw on top the way it does (on-top.ts): no
// depth test, in the transparent pass after everything else, so raised hands and the glow never
// hide them. Their materials skip the depth test where they are made (ui-quad.ts, text-port.ts).
// The group order is the catch: three's projectObject takes a Group's renderOrder as the group
// order of everything under it, and resets it at every Group (a plain Object3D passes it on), so
// every Group under the dock and the chips is made here, the ones a view builds when its widget
// first shows included. Inside, the layers' own renderOrders (views/face.ts) set what is drawn
// over what.

/** A Group in the on-top group order. */
export function onTopGroup(): Group {
  const group = new Group();
  group.renderOrder = ON_TOP_ORDER;
  return group;
}
