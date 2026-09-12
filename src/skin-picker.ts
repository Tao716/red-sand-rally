import { paintCarLivery } from './car-skin';
import { icon } from './icons';
import { isSkinId, SKINS, SKIN_ORDER, type SkinId } from './skins';

const shortNames: Record<SkinId, string> = {
  sandstorm: '经典', midnight: '午夜', glacier: '冰川', neon: '霓虹', venom: '毒液', ember: '熔岩',
};
const hex = (color: number) => `#${color.toString(16).padStart(6, '0')}`;

export function skinPickerMarkup(selected: SkinId): string {
  const skin = SKINS[selected];
  return `<fieldset id="skin-picker" class="skin-picker" aria-label="赛车皮肤" aria-describedby="skin-description skin-save-status">
    <legend class="visually-hidden">赛车皮肤</legend>
    <div class="skin-heading"><span>沙暴 07 <i>/</i> 车身涂装</span><strong id="skin-name">${skin.name}</strong></div>
    <div class="skin-options">${SKIN_ORDER.map(id => {
      const option = SKINS[id];
      return `<label class="skin-option ${id === selected ? 'is-selected' : ''}" data-skin="${id}" title="${option.name} · ${option.tagline}" style="--skin-body:${hex(option.body)};--skin-accent:${hex(option.accent)}">
        <input type="radio" name="skin" value="${id}" aria-label="${option.name}" ${id === selected ? 'checked' : ''} />
        <canvas class="skin-swatch" width="112" height="72" aria-hidden="true"></canvas>
        <span class="skin-option-name">${shortNames[id]}</span><span class="skin-check">${icon('check')}</span>
      </label>`;
    }).join('')}</div>
    <p id="skin-description" class="skin-description">${skin.description}</p>
    <p class="skin-footer"><span>纯外观 · 全部可用</span><span id="skin-save-status" role="status">选中即穿戴</span></p>
  </fieldset>`;
}

/** Use the exact same livery artwork as the 3D car, without fetching thumbnail assets. */
export function paintSkinSwatches(root: HTMLElement): void {
  for (const canvas of root.querySelectorAll<HTMLCanvasElement>('.skin-swatch')) {
    const id = canvas.closest<HTMLElement>('[data-skin]')?.dataset.skin;
    const context = canvas.getContext('2d');
    if (!isSkinId(id) || !context) continue;
    context.save();
    context.scale(canvas.width / 112, canvas.height / 112);
    paintCarLivery(context, SKINS[id], 112);
    context.restore();
  }
}
