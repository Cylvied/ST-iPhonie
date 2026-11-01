import test from 'node:test';
import assert from 'node:assert/strict';
import {retireExpandedWorkflow, runningHubRoute} from '../core/runninghub.js';
const row = (id, type) => ({id, name:id, workflow:JSON.stringify({a:{class_type:type,inputs:{prompt:'%prompt%',max_tokens:768,temperature:.7}}})});
test('removes expansion and switches selected workflow to existing original', () => {
 const original=row('original','RunningHubQwenXianxia'), native=row('native','KSampler');
 const c={activeWorkflow:'expanded',workflows:[native,original,row('expanded','RunningHubQwenXianxiaHauhau')]};
 assert.equal(retireExpandedWorkflow(c),true);
 assert.deepEqual(c.workflows,[native,original]);assert.equal(c.activeWorkflow,'original');
 assert.equal(retireExpandedWorkflow(c),false);
});
test('expanded-only installation becomes original without losing parameters', () => {
 const c={activeWorkflow:'old',workflows:[row('old','RunningHubQwenXianxiaHauhau')]};
 retireExpandedWorkflow(c);assert.equal(c.workflows.length,1);
 const route=runningHubRoute(c.workflows[0].workflow);
 assert.equal(route.node.inputs.prompt,'%prompt%');assert.equal(route.node.inputs.max_tokens,undefined);
 assert.equal(route.workflowId,'2115286699248189441');
});
test('native selection and original settings stay intact', () => {
 const original=row('original','RunningHubQwenXianxia');
 const c={activeWorkflow:'native',workflows:[row('native','KSampler'),original,row('expanded','RunningHubQwenXianxiaHauhau')]};
 retireExpandedWorkflow(c);assert.equal(c.activeWorkflow,'native');assert.equal(c.workflows[1],original);
});
