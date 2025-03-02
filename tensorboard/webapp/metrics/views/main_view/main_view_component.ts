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
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  EventEmitter,
  Input,
  Output,
} from '@angular/core';

import {PluginType} from '../../types';
import {CardObserver} from '../card_renderer/card_lazy_loader';

@Component({
  selector: 'metrics-main-view-component',
  templateUrl: 'main_view_component.ng.html',
  styleUrls: ['main_view_component.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MainViewComponent {
  @Input() showFilteredView!: boolean;

  @Input() isSidepaneOpen!: boolean;

  @Input() filteredPluginTypes!: Set<PluginType>;

  @Input() initialTagsLoading!: boolean;

  @Output() onSettingsButtonClicked = new EventEmitter<void>();

  @Output() onCloseSidepaneButtonClicked = new EventEmitter<void>();

  @Output() onPluginTypeToggled = new EventEmitter<PluginType>();

  @Output() onPluginTypeAllToggled = new EventEmitter<void>();

  constructor(private readonly host: ElementRef) {}

  readonly PluginType = PluginType;

  /**
   * Load cards that are not yet visible, if they are roughly 1 card row away in
   * scroll distance.
   */
  readonly cardObserver = new CardObserver(
    this.host.nativeElement,
    '600px 0px 600px 0px'
  );
}
