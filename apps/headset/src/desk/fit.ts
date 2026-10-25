import type { NormalizedBox, NormalizedPoint } from '@clio/protocol';

// Where the webcam's picture lands on the page, so a box measured on a frame lines up with what
// the video shows. The tracker's and Robotics-ER's coordinates are normalized to the whole frame
// (x right, y down, 0..1); the video element scales the picture by its object-fit and centers it
// (object-position 50% 50%), letterboxing it (contain), cropping it (cover) or stretching it
// (fill). The overlay canvas covers the element exactly, so the picture's rectangle in the
// element is the mapping from the frame to the canvas.

export interface Size {
  width: number;
  height: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type ObjectFit = 'contain' | 'cover' | 'fill' | 'none' | 'scale-down';

/** An element's computed object-fit as one of the values we map; anything else is CSS's fill. */
export function objectFitOf(value: string | null | undefined): ObjectFit {
  const fits: readonly ObjectFit[] = ['contain', 'cover', 'fill', 'none', 'scale-down'];
  return fits.find((f) => f === value) ?? 'fill';
}

/**
 * The picture's rectangle inside an element of size `box` (element pixels, origin top left), for a
 * picture of size `media` under `fit`. Null while either has no size (no frame yet).
 */
export function pictureRect(media: Size, box: Size, fit: ObjectFit): Rect | null {
  if (media.width <= 0 || media.height <= 0 || box.width <= 0 || box.height <= 0) return null;
  if (fit === 'fill') return { x: 0, y: 0, width: box.width, height: box.height };
  const contain = Math.min(box.width / media.width, box.height / media.height);
  const scale =
    fit === 'cover'
      ? Math.max(box.width / media.width, box.height / media.height)
      : fit === 'none'
        ? 1
        : fit === 'scale-down'
          ? Math.min(1, contain)
          : contain;
  const width = media.width * scale;
  const height = media.height * scale;
  return { x: (box.width - width) / 2, y: (box.height - height) / 2, width, height };
}

/** A normalized point of the frame, in the element's pixels. */
export function toPixels(point: NormalizedPoint, rect: Rect): [number, number] {
  return [rect.x + point[0] * rect.width, rect.y + point[1] * rect.height];
}

/** A normalized box of the frame, as a rectangle in the element's pixels. */
export function boxToPixels(box: NormalizedBox, rect: Rect): Rect {
  const [x0, y0] = toPixels([box[0], box[1]], rect);
  const [x1, y1] = toPixels([box[2], box[3]], rect);
  return {
    x: Math.min(x0, x1),
    y: Math.min(y0, y1),
    width: Math.abs(x1 - x0),
    height: Math.abs(y1 - y0),
  };
}

/** A normalized polygon of the frame, in the element's pixels. */
export function polygonToPixels(
  polygon: readonly NormalizedPoint[],
  rect: Rect,
): [number, number][] {
  return polygon.map((p) => toPixels(p, rect));
}

/** The center of a normalized box. */
export function boxCenter(box: NormalizedBox): NormalizedPoint {
  return [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2];
}
