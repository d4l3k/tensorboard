/* Copyright 2020 The TensorFlow Authors. All Rights Reserved.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
==============================================================================*/
import {ComponentType} from '@angular/cdk/overlay';
import {
  ChangeDetectionStrategy,
  Component,
  EventEmitter,
  Input,
  OnInit,
  OnDestroy,
  Output,
} from '@angular/core';
import {Store} from '@ngrx/store';
import {combineLatest, from, Observable, of, Subject} from 'rxjs';
import {
  combineLatestWith,
  debounceTime,
  distinctUntilChanged,
  filter,
  map,
  shareReplay,
  startWith,
  switchMap,
  takeUntil,
} from 'rxjs/operators';

import {State} from '../../../app_state';
import {
  getCardPinnedState,
  getCurrentRouteRunSelection,
  getDarkModeEnabled,
  getExperimentIdForRunId,
  getExperimentIdToAliasMap,
  getMetricsSelectedTime,
  getRun,
  getRunColorMap,
} from '../../../selectors';
import {DataLoadState} from '../../../types/data';
import {classicSmoothing} from '../../../widgets/line_chart_v2/data_transformer';
import {ScaleType} from '../../../widgets/line_chart_v2/types';
import {PluginType, ScalarStepDatum} from '../../data_source';
import {
  getCardLoadState,
  getCardMetadata,
  getCardTimeSeries,
  getMetricsIgnoreOutliers,
  getMetricsScalarPartitionNonMonotonicX,
  getMetricsScalarSmoothing,
  getMetricsTooltipSort,
  getMetricsUseRangeSelectTime,
  getMetricsXAxisType,
  RunToSeries,
} from '../../store';
import {CardId, CardMetadata, LinkedTime, XAxisType} from '../../types';
import {CardRenderer} from '../metrics_view_types';
import {getTagDisplayName} from '../utils';
import {DataDownloadDialogContainer} from './data_download_dialog_container';
import {LinkedTimeWithClipped} from './scalar_card_component';
import {
  PartialSeries,
  PartitionedSeries,
  ScalarCardDataSeries,
  ScalarCardPoint,
  ScalarCardSeriesMetadataMap,
  SeriesType,
} from './scalar_card_types';
import {getDisplayNameForRun, partitionSeries} from './utils';

type ScalarCardMetadata = CardMetadata & {
  plugin: PluginType.SCALARS;
};

function areSeriesEqual(
  listA: PartialSeries[],
  listB: PartialSeries[]
): boolean {
  if (listA.length !== listB.length) {
    return false;
  }
  return listA.every((listAVal, index) => {
    const listBVal = listB[index];
    const listAPoints = listAVal.points;
    const listBPoints = listBVal.points;
    return (
      listAVal.runId === listBVal.runId &&
      listAPoints.length === listBPoints.length &&
      listAPoints.every((listAPoint, index) => {
        const listBPoint = listBPoints[index];
        return listAPoint.x === listBPoint.x && listAPoint.y === listBPoint.y;
      })
    );
  });
}

@Component({
  selector: 'scalar-card',
  template: `
    <scalar-card-component
      [cardId]="cardId"
      [chartMetadataMap]="chartMetadataMap$ | async"
      [DataDownloadComponent]="DataDownloadComponent"
      [dataSeries]="dataSeries$ | async"
      [ignoreOutliers]="ignoreOutliers$ | async"
      [isCardVisible]="isVisible"
      [isPinned]="isPinned$ | async"
      [loadState]="loadState$ | async"
      [showFullSize]="showFullSize"
      [smoothingEnabled]="smoothingEnabled$ | async"
      [tag]="tag$ | async"
      [title]="title$ | async"
      [tooltipSort]="tooltipSort$ | async"
      [xAxisType]="xAxisType$ | async"
      [xScaleType]="xScaleType$ | async"
      [useDarkMode]="useDarkMode$ | async"
      [selectedTime]="selectedTime$ | async"
      (onFullSizeToggle)="onFullSizeToggle()"
      (onPinClicked)="pinStateChanged.emit($event)"
      observeIntersection
      (onVisibilityChange)="onVisibilityChange($event)"
    ></scalar-card-component>
  `,
  styles: [
    `
      :host {
        display: block;
        height: 100%;
      }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ScalarCardContainer implements CardRenderer, OnInit, OnDestroy {
  constructor(private readonly store: Store<State>) {}

  // Angular Component constructor for DataDownload dialog. It is customizable for
  // testability, without mocking out data for the component's internals, but defaults to
  // the DataDownloadDialogContainer.
  @Input() DataDownloadComponent: ComponentType<
    any
  > = DataDownloadDialogContainer;
  @Input() cardId!: CardId;
  @Input() groupName!: string | null;
  @Output() fullWidthChanged = new EventEmitter<boolean>();
  @Output() fullHeightChanged = new EventEmitter<boolean>();
  @Output() pinStateChanged = new EventEmitter<boolean>();

  isVisible: boolean = false;
  loadState$?: Observable<DataLoadState>;
  title$?: Observable<string>;
  tag$?: Observable<string>;
  isPinned$?: Observable<boolean>;
  dataSeries$?: Observable<ScalarCardDataSeries[]>;
  chartMetadataMap$?: Observable<ScalarCardSeriesMetadataMap>;
  selectedTime$?: Observable<LinkedTimeWithClipped | null>;

  onVisibilityChange({visible}: {visible: boolean}) {
    this.isVisible = visible;
  }

  readonly useDarkMode$ = this.store.select(getDarkModeEnabled);
  readonly ignoreOutliers$ = this.store.select(getMetricsIgnoreOutliers);
  readonly tooltipSort$ = this.store.select(getMetricsTooltipSort);
  readonly xAxisType$ = this.store.select(getMetricsXAxisType);
  readonly xScaleType$ = this.store.select(getMetricsXAxisType).pipe(
    map((xAxisType) => {
      switch (xAxisType) {
        case XAxisType.STEP:
        case XAxisType.RELATIVE:
          return ScaleType.LINEAR;
        case XAxisType.WALL_TIME:
          return ScaleType.TIME;
        default:
          const neverType = xAxisType as never;
          throw new Error(`Invalid xAxisType for line chart. ${neverType}`);
      }
    })
  );

  readonly scalarSmoothing$ = this.store.select(getMetricsScalarSmoothing);
  readonly smoothingEnabled$ = this.store
    .select(getMetricsScalarSmoothing)
    .pipe(map((smoothing) => smoothing > 0));

  showFullSize = false;

  private readonly ngUnsubscribe = new Subject<void>();

  private isScalarCardMetadata(
    cardMetadata: CardMetadata
  ): cardMetadata is ScalarCardMetadata {
    const {plugin} = cardMetadata;
    return plugin === PluginType.SCALARS;
  }

  onFullSizeToggle() {
    this.showFullSize = !this.showFullSize;
    this.fullWidthChanged.emit(this.showFullSize);
    this.fullHeightChanged.emit(this.showFullSize);
  }

  /**
   * Build observables once cardId is defined (after onInit).
   */
  ngOnInit() {
    const selectCardMetadata$ = this.store.select(getCardMetadata, this.cardId);
    const cardMetadata$ = selectCardMetadata$.pipe(
      filter((cardMetadata) => {
        return !!cardMetadata && this.isScalarCardMetadata(cardMetadata);
      }),
      map((cardMetadata) => {
        return cardMetadata as ScalarCardMetadata;
      })
    );

    const nonNullRunsToScalarSeries$ = this.store
      .select(getCardTimeSeries, this.cardId)
      .pipe(
        takeUntil(this.ngUnsubscribe),
        filter((runToSeries) => Boolean(runToSeries)),
        map((runToSeries) => runToSeries as RunToSeries<PluginType.SCALARS>),
        shareReplay(1)
      );

    const partialSeries$ = nonNullRunsToScalarSeries$.pipe(
      combineLatestWith(this.store.select(getMetricsXAxisType)),
      map(([runToSeries, xAxisType]) => {
        const runIds = Object.keys(runToSeries);
        const results = runIds.map((runId) => {
          return {
            runId,
            points: this.stepSeriesToLineSeries(runToSeries[runId], xAxisType),
          };
        });
        return results;
      }),
      distinctUntilChanged(areSeriesEqual)
    );

    function getSmoothedSeriesId(seriesId: string): string {
      return JSON.stringify(['smoothed', seriesId]);
    }

    const normalizedPartialSeries$ = partialSeries$.pipe(
      combineLatestWith(this.store.select(getMetricsXAxisType)),
      // Normalize time and, optionally, compute relative time.
      map(([partialSeries, xAxisType]) => {
        return partialSeries.map((partial) => {
          // Normalize data and convert wallTime in seconds to milliseconds.
          // TODO(stephanwlee): when the legacy line chart is removed, do the conversion
          // at the effects.
          let normalizedPoints = partial.points.map((point) => {
            const wallTime = point.wallTime * 1000;
            const x = xAxisType === XAxisType.STEP ? point.x : wallTime;

            return {...point, x, wallTime};
          });

          if (xAxisType === XAxisType.RELATIVE && normalizedPoints.length) {
            const firstPoint = normalizedPoints[0];
            normalizedPoints = normalizedPoints.map((point) => ({
              ...point,
              x: point.x - firstPoint.x,
            }));
          }

          return {runId: partial.runId, points: normalizedPoints};
        });
      })
    );

    const partitionedSeries$ = normalizedPartialSeries$.pipe(
      combineLatestWith(
        this.store.select(getMetricsScalarPartitionNonMonotonicX)
      ),
      takeUntil(this.ngUnsubscribe),
      map<[PartialSeries[], boolean], PartitionedSeries[]>(
        ([normalizedSeries, enablePartition]) => {
          if (enablePartition) return partitionSeries(normalizedSeries);

          return normalizedSeries.map((series) => {
            return {
              ...series,
              seriesId: series.runId,
              partitionIndex: 0,
              partitionSize: 1,
            };
          });
        }
      ),
      shareReplay(1)
    );

    this.dataSeries$ = partitionedSeries$.pipe(
      // Smooth
      combineLatestWith(this.store.select(getMetricsScalarSmoothing)),
      switchMap<
        [PartitionedSeries[], number],
        Observable<ScalarCardDataSeries[]>
      >(([runsData, smoothing]) => {
        const cleanedRunsData = runsData.map(({seriesId, points}) => ({
          id: seriesId,
          points,
        }));
        if (smoothing <= 0) {
          return of(cleanedRunsData);
        }

        return from(classicSmoothing(cleanedRunsData, smoothing)).pipe(
          map((smoothedDataSeriesList) => {
            const smoothedList = cleanedRunsData.map((dataSeries, index) => {
              return {
                id: getSmoothedSeriesId(dataSeries.id),
                points: smoothedDataSeriesList[index].points.map(
                  ({y}, pointIndex) => {
                    return {...dataSeries.points[pointIndex], y};
                  }
                ),
              };
            });
            return [...cleanedRunsData, ...smoothedList];
          })
        );
      }),
      startWith([] as ScalarCardDataSeries[])
    );

    this.selectedTime$ = combineLatest([
      partitionedSeries$,
      this.store.select(getMetricsSelectedTime),
      this.store.select(getMetricsXAxisType),
    ]).pipe(
      map(([series, selectedTime, xAxisType]) => {
        if (xAxisType !== XAxisType.STEP || !selectedTime) return null;

        let minStep = Infinity;
        let maxStep = -Infinity;
        for (const {points} of series) {
          for (const point of points) {
            minStep = minStep > point.x ? point.x : minStep;
            maxStep = maxStep < point.x ? point.x : maxStep;
          }
        }

        if (
          // Case when selectedTime contains extents.
          (selectedTime.start.step <= minStep &&
            selectedTime.end &&
            maxStep <= selectedTime.end.step) ||
          // Case when start of selectedTime is within extent.
          (minStep <= selectedTime.start.step &&
            selectedTime.start.step <= maxStep) ||
          // Case when end of selectedTime is within extent.
          (selectedTime.end &&
            minStep <= selectedTime.end?.step &&
            selectedTime.end?.step <= maxStep)
        ) {
          return {...selectedTime, clipped: false};
        }

        // When selectedTime and data extent (in step axis) do not overlap,
        // default single select min or max data extent depending on which side
        // the selectedTime is at.

        // Case when selectedTime is on the right of the maximum of the
        // time series.
        if (maxStep <= selectedTime.start.step) {
          return {
            start: {step: maxStep},
            end: null,
            clipped: true,
          };
        }
        // Case when selectedtime is on the left of the minimum of the time
        // series.
        return {
          start: {step: minStep},
          end: null,
          clipped: true,
        };
      })
    );

    this.chartMetadataMap$ = partitionedSeries$.pipe(
      switchMap<
        PartitionedSeries[],
        Observable<Array<PartitionedSeries & {displayName: string}>>
      >((partitioned) => {
        return combineLatest(
          partitioned.map((series) => {
            return this.getRunDisplayName(series.runId).pipe(
              map((displayName) => {
                return {...series, displayName};
              })
            );
          })
        );
      }),
      combineLatestWith(
        this.store.select(getCurrentRouteRunSelection),
        this.store.select(getRunColorMap),
        this.store.select(getMetricsScalarSmoothing)
      ),
      // When the `fetchRunsSucceeded` action fires, the run selection
      // map and the metadata change. To prevent quick fire of changes,
      // debounce by a microtask to emit only single change for the runs
      // store change.
      debounceTime(0),
      map(([namedPartitionedSeries, runSelectionMap, colorMap, smoothing]) => {
        const metadataMap: ScalarCardSeriesMetadataMap = {};
        const shouldSmooth = smoothing > 0;

        for (const partitioned of namedPartitionedSeries) {
          const {
            seriesId,
            runId,
            displayName,
            partitionIndex,
            partitionSize,
          } = partitioned;

          metadataMap[seriesId] = {
            type: SeriesType.ORIGINAL,
            id: seriesId,
            displayName:
              partitionSize > 1
                ? `${displayName}: ${partitionIndex}`
                : displayName,
            visible: Boolean(runSelectionMap && runSelectionMap.get(runId)),
            color: colorMap[runId] ?? '#fff',
            aux: false,
            opacity: 1,
          };
        }

        if (!shouldSmooth) {
          return metadataMap;
        }

        for (const [id, metadata] of Object.entries(metadataMap)) {
          const smoothedSeriesId = getSmoothedSeriesId(id);
          metadataMap[smoothedSeriesId] = {
            ...metadata,
            id: smoothedSeriesId,
            type: SeriesType.DERIVED,
            aux: false,
            originalSeriesId: id,
          };

          metadata.aux = true;
          metadata.opacity = 0.25;
        }

        return metadataMap;
      }),
      startWith({} as ScalarCardSeriesMetadataMap)
    );

    this.loadState$ = this.store.select(getCardLoadState, this.cardId);

    this.tag$ = cardMetadata$.pipe(
      map((cardMetadata) => {
        return cardMetadata.tag;
      })
    );

    this.title$ = this.tag$.pipe(
      map((tag) => {
        return getTagDisplayName(tag, this.groupName);
      })
    );

    this.isPinned$ = this.store.select(getCardPinnedState, this.cardId);
  }

  ngOnDestroy() {
    this.ngUnsubscribe.next();
    this.ngUnsubscribe.complete();
  }

  private getRunDisplayName(runId: string): Observable<string> {
    return combineLatest([
      this.store.select(getExperimentIdForRunId, {runId}),
      this.store.select(getExperimentIdToAliasMap),
      this.store.select(getRun, {runId}),
    ]).pipe(
      map(([experimentId, idToAlias, run]) => {
        return getDisplayNameForRun(
          runId,
          run,
          experimentId ? idToAlias[experimentId] : null
        );
      })
    );
  }

  private stepSeriesToLineSeries(
    stepSeries: ScalarStepDatum[],
    xAxisType: XAxisType
  ): ScalarCardPoint[] {
    const isStepBased = xAxisType === XAxisType.STEP;
    return stepSeries.map((stepDatum) => {
      return {
        ...stepDatum,
        x: isStepBased ? stepDatum.step : stepDatum.wallTime,
        y: stepDatum.value,
      };
    });
  }
}
