/* Copyright 2015 The TensorFlow Authors. All Rights Reserved.

Licensed under the Apache License, Version 2.0 (the 'License');
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an 'AS IS' BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
==============================================================================*/
import * as d3 from 'd3';

const FRAC_VIEWPOINT_AREA: number = 0.8;
export class Minimap {
  /** The minimap container. */
  private minimap: HTMLElement;
  /** The canvas used for drawing the mini version of the svg. */
  private canvas: HTMLCanvasElement;
  /** A buffer canvas used for temporary drawing to avoid flickering. */
  private canvasBuffer: HTMLCanvasElement;
  private downloadCanvas: HTMLCanvasElement;
  /** The minimap svg used for holding the viewpoint rectangle. */
  private minimapSvg: SVGSVGElement;
  /** The rectangle showing the current viewpoint. */
  private viewpoint: SVGRectElement;
  /**
   * The scale factor for the minimap. The factor is determined automatically
   * so that the minimap doesn't violate the maximum width/height specified
   * in the constructor. The minimap maintains the same aspect ratio as the
   * original svg.
   */
  private scaleMinimap: number;
  /** The main svg element. */
  private svg: SVGSVGElement;
  /** The svg group used for panning and zooming the main svg. */
  private zoomG: SVGGElement;
  /** The zoom behavior of the main svg. */
  private mainZoom: d3.ZoomBehavior<any, any>;
  /** The maximum width and height for the minimap. */
  private maxWandH: number;
  /** The last translation vector used in the main svg. */
  private translate: [number, number];
  /** The last scaling factor used in the main svg. */
  private scaleMain: number;
  /** The coordinates of the viewpoint rectangle. */
  private viewpointCoord: {
    x: number;
    y: number;
  };
  /** The current size of the minimap */
  private minimapSize: {
    width: number;
    height: number;
  };
  /** Padding (px) due to the main labels of the graph. */
  private labelPadding: number;
  /**
   * Constructs a new minimap.
   *
   * @param svg The main svg element.
   * @param zoomG The svg group used for panning and zooming the main svg.
   * @param mainZoom The main zoom behavior.
   * @param minimap The minimap container.
   * @param maxWandH The maximum width/height for the minimap.
   * @param labelPadding Padding in pixels due to the main graph labels.
   */
  constructor(
    svg: SVGSVGElement,
    zoomG: SVGGElement,
    mainZoom: d3.ZoomBehavior<any, any>,
    minimap: HTMLElement,
    maxWandH: number,
    labelPadding: number
  ) {
    this.svg = svg;
    this.labelPadding = labelPadding;
    this.zoomG = zoomG;
    this.mainZoom = mainZoom;
    this.maxWandH = maxWandH;
    let $shadowRoot = d3.select((minimap.shadowRoot as unknown) as Element);
    // The minimap will have 2 main components: the canvas showing the content
    // and an svg showing a rectangle of the currently zoomed/panned viewpoint.
    let $minimapSvg = $shadowRoot.select('svg');
    // Make the viewpoint rectangle draggable.
    let $viewpoint = $minimapSvg.select('rect');
    let dragmove = (d) => {
      this.viewpointCoord.x = (<DragEvent>d3.event).x;
      this.viewpointCoord.y = (<DragEvent>d3.event).y;
      this.updateViewpoint();
    };
    this.viewpointCoord = {x: 0, y: 0};
    let drag = d3.drag().subject(Object).on('drag', dragmove);
    $viewpoint.datum(this.viewpointCoord as any).call(drag);
    // Make the minimap clickable.
    $minimapSvg.on('click', () => {
      if ((<Event>d3.event).defaultPrevented) {
        // This click was part of a drag event, so suppress it.
        return;
      }
      // Update the coordinates of the viewpoint.
      let width = Number($viewpoint.attr('width'));
      let height = Number($viewpoint.attr('height'));
      let clickCoords = d3.mouse($minimapSvg.node() as any);
      this.viewpointCoord.x = clickCoords[0] - width / 2;
      this.viewpointCoord.y = clickCoords[1] - height / 2;
      this.updateViewpoint();
    });
    this.viewpoint = <SVGRectElement>$viewpoint.node();
    this.minimapSvg = <SVGSVGElement>$minimapSvg.node();
    this.minimap = minimap;
    this.canvas = <HTMLCanvasElement>$shadowRoot.select('canvas.first').node();
    this.canvasBuffer = <HTMLCanvasElement>(
      $shadowRoot.select('canvas.second').node()
    );
    this.downloadCanvas = <HTMLCanvasElement>(
      $shadowRoot.select('canvas.download').node()
    );
    d3.select(this.downloadCanvas).style('display', 'none');
    this.update();
  }
  /**
   * Updates the position and the size of the viewpoint rectangle.
   * It also notifies the main svg about the new panned position.
   */
  private updateViewpoint(): void {
    // Update the coordinates of the viewpoint rectangle.
    d3.select(this.viewpoint)
      .attr('x', this.viewpointCoord.x)
      .attr('y', this.viewpointCoord.y);
    // Update the translation vector of the main svg to reflect the
    // new viewpoint.
    let mainX = (-this.viewpointCoord.x * this.scaleMain) / this.scaleMinimap;
    let mainY = (-this.viewpointCoord.y * this.scaleMain) / this.scaleMinimap;
    d3.select(this.svg).call(
      this.mainZoom.transform,
      d3.zoomIdentity.translate(mainX, mainY).scale(this.scaleMain)
    );
  }
  /**
   * Takes a snapshot of the graph's image as a Blob.
   */
  getImageBlob(): Promise<Blob> {
    return new Promise<Blob>((resolve) => {
      this.downloadCanvas.toBlob((blob) => {
        resolve(blob);
      }, 'image/png');
    });
  }
  /**
   * Redraws the minimap. Should be called whenever the main svg
   * was updated (e.g. when a node was expanded).
   */
  update(): void {
    let sceneSize = null;
    try {
      // Get the size of the entire scene.
      sceneSize = this.zoomG.getBBox();
      if (sceneSize.width === 0) {
        // There is no scene anymore. We have been detached from the dom.
        return;
      }
    } catch (e) {
      // Firefox produced NS_ERROR_FAILURE if we have been
      // detached from the dom.
      return;
    }
    let $svg = d3.select(this.svg);
    // Read all the style rules in the document and embed them into the svg.
    // The svg needs to be self contained, i.e. all the style rules need to be
    // embedded so the canvas output matches the origin.
    let stylesText = '';
    const anySvg = this.svg as any;
    // MSEdge does not have `getRootNode`. In that case, manually get the root
    // node. This is more brittle than the getRootNode as changing DOM structure
    // will break this.
    const rootNode = anySvg.getRootNode
      ? anySvg.getRootNode()
      : this.svg.parentNode;
    const styleSheets = rootNode.styleSheets;
    for (let k = 0; k < styleSheets.length; k++) {
      try {
        let cssRules =
          (<any>styleSheets[k]).cssRules || (<any>styleSheets[k]).rules;
        if (cssRules == null) {
          continue;
        }
        for (let i = 0; i < cssRules.length; i++) {
          // Remove tf-* selectors from the styles.
          stylesText +=
            cssRules[i].cssText.replace(/ ?tf-[\w-]+ ?/g, '') + '\n';
        }
      } catch (e) {
        if (e.name !== 'SecurityError') {
          throw e;
        }
      }
    }
    // Temporarily add the css rules to the main svg.
    let svgStyle = $svg.append('style');
    svgStyle.text(stylesText);
    // Temporarily remove the zoom/pan transform from the main svg since we
    // want the minimap to show a zoomed-out and centered view.
    let $zoomG = d3.select(this.zoomG);
    let zoomTransform = $zoomG.attr('transform');
    $zoomG.attr('transform', null);
    // https://github.com/tensorflow/tensorboard/issues/1598
    // Account for SVG content shift. SVGGraphicsElement.getBBox().width returns
    // width in pixel value of very tight bounding box of non-empty content.
    // Since we want to measure the sceneSize from the origin to the right most
    // edge of the right most node, we need to account for distance from the
    // origin to the left edge of the bounding box.
    sceneSize.height += sceneSize.y;
    sceneSize.width += sceneSize.x;
    // Since we add padding, account for that here.
    sceneSize.height += this.labelPadding * 2;
    sceneSize.width += this.labelPadding * 2;
    // Temporarily assign an explicit width/height to the main svg, since
    // it doesn't have one (uses flex-box), but we need it for the canvas
    // to work.
    $svg.attr('width', sceneSize.width).attr('height', sceneSize.height);
    // Since the content inside the svg changed (e.g. a node was expanded),
    // the aspect ratio have also changed. Thus, we need to update the scale
    // factor of the minimap. The scale factor is determined such that both
    // the width and height of the minimap are <= maximum specified w/h.
    this.scaleMinimap =
      this.maxWandH / Math.max(sceneSize.width, sceneSize.height);
    this.minimapSize = {
      width: sceneSize.width * this.scaleMinimap,
      height: sceneSize.height * this.scaleMinimap,
    };
    // Update the size of the minimap's svg, the buffer canvas and the
    // viewpoint rect.
    d3.select(this.minimapSvg).attr(<any>this.minimapSize);
    d3.select(this.canvasBuffer).attr(<any>this.minimapSize);
    // Download canvas width and height are multiples of the style width and
    // height in order to increase pixel density of the PNG for clarity.
    const downloadCanvasSelection = d3.select(this.downloadCanvas);
    downloadCanvasSelection.style('width', sceneSize.width);
    downloadCanvasSelection.style('height', sceneSize.height);
    downloadCanvasSelection.attr('width', 3 * sceneSize.width);
    downloadCanvasSelection.attr('height', 3 * sceneSize.height);
    if (this.translate != null && this.zoom != null) {
      // Update the viewpoint rectangle shape since the aspect ratio of the
      // map has changed.
      requestAnimationFrame(() => this.zoom());
    }
    // TODO(stephanwlee): Consider not mutating the original DOM then read it --
    // this may cause reflow.
    // Serialize the main svg to a string which will be used as the rendering
    // content for the canvas.
    let svgXml = new XMLSerializer().serializeToString(this.svg);
    // Now that the svg is serialized for rendering, remove the temporarily
    // assigned styles, explicit width and height and bring back the pan/zoom
    // transform.
    svgStyle.remove();
    $svg.attr('width', null).attr('height', null);
    $zoomG.attr('transform', zoomTransform);
    let image = new Image();
    image.onload = () => {
      // Draw the svg content onto the buffer canvas.
      let context = this.canvasBuffer.getContext('2d');
      context.clearRect(
        0,
        0,
        this.canvasBuffer.width,
        this.canvasBuffer.height
      );
      context.drawImage(
        image,
        0,
        0,
        this.minimapSize.width,
        this.minimapSize.height
      );
      requestAnimationFrame(() => {
        // Hide the old canvas and show the new buffer canvas.
        d3.select(this.canvasBuffer).style('display', null);
        d3.select(this.canvas).style('display', 'none');
        // Swap the two canvases.
        [this.canvas, this.canvasBuffer] = [this.canvasBuffer, this.canvas];
      });
      let downloadContext = this.downloadCanvas.getContext('2d');
      downloadContext.clearRect(
        0,
        0,
        this.downloadCanvas.width,
        this.downloadCanvas.height
      );
      downloadContext.drawImage(
        image,
        0,
        0,
        this.downloadCanvas.width,
        this.downloadCanvas.height
      );
    };
    image.onerror = () => {
      let blob = new Blob([svgXml], {type: 'image/svg+xml;charset=utf-8'});
      image.src = (URL as any).createObjectURL(blob);
    };
    image.src =
      'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgXml);
  }
  /**
   * Handles changes in zooming/panning. Should be called from the main svg
   * to notify that a zoom/pan was performed and this minimap will update it's
   * viewpoint rectangle.
   *
   * @param translate The translate vector, or none to use the last used one.
   * @param scale The scaling factor, or none to use the last used one.
   */
  zoom(transform?: d3.ZoomTransform): void {
    if (this.scaleMinimap == null) {
      // Scene is not ready yet.
      return;
    }
    // Update the new translate and scale params, only if specified.
    if (transform) {
      this.translate = [transform.x, transform.y];
      this.scaleMain = transform.k;
    }
    // Update the location of the viewpoint rectangle.
    let svgRect = this.svg.getBoundingClientRect();
    let $viewpoint = d3.select(this.viewpoint);
    this.viewpointCoord.x =
      (-this.translate[0] * this.scaleMinimap) / this.scaleMain;
    this.viewpointCoord.y =
      (-this.translate[1] * this.scaleMinimap) / this.scaleMain;
    let viewpointWidth = (svgRect.width * this.scaleMinimap) / this.scaleMain;
    let viewpointHeight = (svgRect.height * this.scaleMinimap) / this.scaleMain;
    $viewpoint
      .attr('x', this.viewpointCoord.x)
      .attr('y', this.viewpointCoord.y)
      .attr('width', viewpointWidth)
      .attr('height', viewpointHeight);
    // Show/hide the minimap depending on the viewpoint area as fraction of the
    // whole minimap.
    let mapWidth = this.minimapSize.width;
    let mapHeight = this.minimapSize.height;
    let x = this.viewpointCoord.x;
    let y = this.viewpointCoord.y;
    let w =
      Math.min(Math.max(0, x + viewpointWidth), mapWidth) -
      Math.min(Math.max(0, x), mapWidth);
    let h =
      Math.min(Math.max(0, y + viewpointHeight), mapHeight) -
      Math.min(Math.max(0, y), mapHeight);
    let fracIntersect = (w * h) / (mapWidth * mapHeight);
    if (fracIntersect < FRAC_VIEWPOINT_AREA) {
      this.minimap.classList.remove('hidden');
    } else {
      this.minimap.classList.add('hidden');
    }
  }
}
