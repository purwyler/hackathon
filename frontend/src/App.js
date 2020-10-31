import React, { useState, useEffect } from 'react';
import './assests/css/App.css';
import Amplify from 'aws-amplify';
import awsconfig from './aws-exports';
import AWS from 'aws-sdk';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

import useScript from './hooks/useScript';

const THREE = window.THREE
const HOST = window.HOST

// Set up base scene
function createScene() {
  // Base scene
  const scene = new THREE.Scene();
  const clock = new THREE.Clock();
  scene.background = new THREE.Color(0x33334d);
  scene.fog = new THREE.Fog(0x33334d, 0, 10);

  // Renderer
  const renderer = new THREE.WebGLRenderer({antialias: true});
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputEncoding = THREE.sRGBEncoding;
  renderer.shadowMap.enabled = true;
  renderer.setClearColor(0x33334d);
  renderer.domElement.id = 'renderCanvas';
  document.getElementById('container').appendChild(renderer.domElement)

  // Env map
  new THREE.TextureLoader()
    .load('assets/images/machine_shop.jpg', hdrEquirect => {

      const pmremGenerator = new THREE.PMREMGenerator(renderer);
      pmremGenerator.compileEquirectangularShader();

      const hdrCubeRenderTarget = pmremGenerator.fromEquirectangular(
        hdrEquirect
      );
      hdrEquirect.dispose();
      pmremGenerator.dispose();

      scene.environment = hdrCubeRenderTarget.texture;

    });


  // Camera
  const camera = new THREE.PerspectiveCamera(
    THREE.MathUtils.radToDeg(0.8),
    window.innerWidth / window.innerHeight,
    0.1,
    1000
  );
  const controls = new OrbitControls(camera, renderer.domElement);
  camera.position.set(0, 1.4, 3.1);
  controls.target = new THREE.Vector3(0, 0.8, 0);
  controls.screenSpacePanning = true;
  controls.update();

  // Handle window resize
  function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  }
  window.addEventListener('resize', onWindowResize, false);

  // Render loop
  function render() {
    requestAnimationFrame(render);
    controls.update();

    renderFn.forEach(fn => {
      fn();
    });

    renderer.render(scene, camera);
  }

  render();

  // Lights
  const hemiLight = new THREE.HemisphereLight(0xffffff, 0x000000, 0.6);
  hemiLight.position.set(0, 200, 0);
  hemiLight.intensity = 0.6;
  scene.add(hemiLight);

  const dirLight = new THREE.DirectionalLight(0xffffff);
  dirLight.position.set(0, 5, 5);

  dirLight.castShadow = true;
  dirLight.shadow.mapSize.width = 1024;
  dirLight.shadow.mapSize.height = 1024;
  dirLight.shadow.camera.top = 2.5;
  dirLight.shadow.camera.bottom = -2.5;
  dirLight.shadow.camera.left = -2.5;
  dirLight.shadow.camera.right = 2.5;
  dirLight.shadow.camera.near = 0.1;
  dirLight.shadow.camera.far = 40;
  scene.add(dirLight);

  const dirLightTarget = new THREE.Object3D();
  dirLight.add(dirLightTarget);
  dirLightTarget.position.set(0, -0.5, -1.0);
  dirLight.target = dirLightTarget;

  // Environment
  const groundMat = new THREE.MeshStandardMaterial({
    color: 0x808080,
    depthWrite: false,
  });
  groundMat.metalness = 0;
  groundMat.refractionRatio = 0;
  const ground = new THREE.Mesh(
    new THREE.PlaneBufferGeometry(100, 100),
    groundMat
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  return {scene, camera, clock};
}

// Load character model and animations
async function loadCharacter(
  scene,
  characterFile,
  animationPath,
  animationFiles
) {
  // Asset loader
  const fileLoader = new THREE.FileLoader();
  const gltfLoader = new GLTFLoader();

  function loadAsset(loader, assetPath, onLoad) {
    return new Promise(resolve => {
      loader.load(assetPath, async asset => {
        if (onLoad[Symbol.toStringTag] === 'AsyncFunction') {
          const result = await onLoad(asset);
          resolve(result);
        } else {
          resolve(onLoad(asset));
        }
      });
    });
  }

  // Load character model
  const {character, bindPoseOffset} = await loadAsset(
    gltfLoader,
    characterFile,
    gltf => {
      // Transform the character
      const character = gltf.scene;
      scene.add(character);

      // Make the offset pose additive
      const [bindPoseOffset] = gltf.animations;
      if (bindPoseOffset) {
        THREE.AnimationUtils.makeClipAdditive(bindPoseOffset);
      }

      // Cast shadows
      character.traverse(object => {
        if (object.isMesh) {
          object.castShadow = true;
        }
      });

      return {character, bindPoseOffset};
    }
  );

  // Load animations
  const clips = await Promise.all(
    animationFiles.map((filename, index) => {
      const filePath = `${animationPath}/${filename}`;

      return loadAsset(gltfLoader, filePath, async gltf => {
        return gltf.animations;
      });
    })
  );

  return {character, clips, bindPoseOffset};
}

// Initialize the host
function createHost(
  character,
  audioAttachJoint,
  voice,
  engine,
  idleClip,
  faceIdleClip,
  lipsyncClips,
  gestureClips,
  gestureConfig,
  emoteClips,
  blinkClips,
  poiClips,
  poiConfig,
  lookJoint,
  bindPoseOffset,
  clock,
  camera,
  scene
) {
  // Add the host to the render loop
  const host = new HOST.HostObject({owner: character, clock});
  renderFn.push(() => {
    host.update();
  });

  // Set up text to speech
  const audioListener = new THREE.AudioListener();
  camera.add(audioListener);
  host.addFeature(HOST.aws.TextToSpeechFeature, false, {
    listener: audioListener,
    attachTo: audioAttachJoint,
    voice,
    engine,
  });

  // Set up animation
  host.addFeature(HOST.anim.AnimationFeature);

  // Base idle
  host.AnimationFeature.addLayer('Base');
  host.AnimationFeature.addAnimation(
    'Base',
    idleClip.name,
    HOST.anim.AnimationTypes.single,
    {clip: idleClip}
  );
  host.AnimationFeature.playAnimation('Base', idleClip.name);

  // Face idle
  host.AnimationFeature.addLayer('Face', {
    blendMode: HOST.anim.LayerBlendModes.Additive,
  });
  THREE.AnimationUtils.makeClipAdditive(faceIdleClip);
  host.AnimationFeature.addAnimation(
    'Face',
    faceIdleClip.name,
    HOST.anim.AnimationTypes.single,
    {
      clip: THREE.AnimationUtils.subclip(
        faceIdleClip,
        faceIdleClip.name,
        1,
        faceIdleClip.duration * 30,
        30
      ),
    }
  );
  host.AnimationFeature.playAnimation('Face', faceIdleClip.name);

  // Blink
  host.AnimationFeature.addLayer('Blink', {
    blendMode: HOST.anim.LayerBlendModes.Additive,
    transitionTime: 0.075,
  });
  blinkClips.forEach(clip => {
    THREE.AnimationUtils.makeClipAdditive(clip);
  });
  host.AnimationFeature.addAnimation(
    'Blink',
    'blink',
    HOST.anim.AnimationTypes.randomAnimation,
    {
      playInterval: 3,
      subStateOptions: blinkClips.map(clip => {
        return {
          name: clip.name,
          loopCount: 1,
          clip,
        };
      }),
    }
  );
  host.AnimationFeature.playAnimation('Blink', 'blink');

  // Talking idle
  host.AnimationFeature.addLayer('Talk', {
    transitionTime: 0.75,
    blendMode: HOST.anim.LayerBlendModes.Additive,
  });
  host.AnimationFeature.setLayerWeight('Talk', 0);
  const talkClip = lipsyncClips.find(c => c.name === 'stand_talk');
  lipsyncClips.splice(lipsyncClips.indexOf(talkClip), 1);
  host.AnimationFeature.addAnimation(
    'Talk',
    talkClip.name,
    HOST.anim.AnimationTypes.single,
    {clip: THREE.AnimationUtils.makeClipAdditive(talkClip)}
  );
  host.AnimationFeature.playAnimation('Talk', talkClip.name);

  // Gesture animations
  host.AnimationFeature.addLayer('Gesture', {
    transitionTime: 0.5,
    blendMode: HOST.anim.LayerBlendModes.Additive,
  });
  gestureClips.forEach(clip => {
    const {name} = clip;
    const config = gestureConfig[name];
    THREE.AnimationUtils.makeClipAdditive(clip);

    if (config !== undefined) {
      config.queueOptions.forEach((option, index) => {
        // Create a subclip for each range in queueOptions
        option.clip = THREE.AnimationUtils.subclip(
          clip,
          `${name}_${option.name}`,
          option.from,
          option.to,
          30
        );
      });
      host.AnimationFeature.addAnimation(
        'Gesture',
        name,
        HOST.anim.AnimationTypes.queue,
        config
      );
    } else {
      host.AnimationFeature.addAnimation(
        'Gesture',
        name,
        HOST.anim.AnimationTypes.single,
        {clip}
      );
    }
  });

  // Emote animations
  host.AnimationFeature.addLayer('Emote', {
    transitionTime: 0.5,
  });

  emoteClips.forEach(clip => {
    const {name} = clip;
    host.AnimationFeature.addAnimation(
      'Emote',
      name,
      HOST.anim.AnimationTypes.single,
      {clip, loopCount: 1}
    );
  });

  // Viseme poses
  host.AnimationFeature.addLayer('Viseme', {
    transitionTime: 0.12,
    blendMode: HOST.anim.LayerBlendModes.Additive,
  });
  host.AnimationFeature.setLayerWeight('Viseme', 0);

  // Slice off the reference frame
  const blendStateOptions = lipsyncClips.map(clip => {
    THREE.AnimationUtils.makeClipAdditive(clip);
    return {
      name: clip.name,
      clip: THREE.AnimationUtils.subclip(clip, clip.name, 1, 2, 30),
      weight: 0,
    };
  });
  host.AnimationFeature.addAnimation(
    'Viseme',
    'visemes',
    HOST.anim.AnimationTypes.freeBlend,
    {blendStateOptions}
  );
  host.AnimationFeature.playAnimation('Viseme', 'visemes');

  // POI poses
  poiConfig.forEach(config => {
    host.AnimationFeature.addLayer(config.name, {
      blendMode: HOST.anim.LayerBlendModes.Additive,
    });

    // Find each pose clip and make it additive
    config.blendStateOptions.forEach(clipConfig => {
      const clip = poiClips.find(clip => clip.name === clipConfig.clip);
      THREE.AnimationUtils.makeClipAdditive(clip);
      clipConfig.clip = THREE.AnimationUtils.subclip(
        clip,
        clip.name,
        1,
        2,
        30
      );
    });

    host.AnimationFeature.addAnimation(
      config.name,
      config.animation,
      HOST.anim.AnimationTypes.blend2d,
      {...config}
    );

    host.AnimationFeature.playAnimation(config.name, config.animation);

    // Find and store reference objects
    config.reference = character.getObjectByName(
      config.reference.replace(':', '')
    );
  });

  // Apply bindPoseOffset clip if it exists
  if (bindPoseOffset !== undefined) {
    host.AnimationFeature.addLayer('BindPoseOffset', {
      blendMode: HOST.anim.LayerBlendModes.Additive,
    });
    host.AnimationFeature.addAnimation(
      'BindPoseOffset',
      bindPoseOffset.name,
      HOST.anim.AnimationTypes.single,
      {
        clip: THREE.AnimationUtils.subclip(
          bindPoseOffset,
          bindPoseOffset.name,
          1,
          2,
          30
        ),
      }
    );
    host.AnimationFeature.playAnimation(
      'BindPoseOffset',
      bindPoseOffset.name
    );
  }

  // Set up Lipsync
  const visemeOptions = {
    layers: [{name: 'Viseme', animation: 'visemes'}],
  };
  const talkingOptions = {
    layers: [
      {
        name: 'Talk',
        animation: 'stand_talk',
        blendTime: 0.75,
        easingFn: HOST.anim.Easing.Quadratic.InOut,
      },
    ],
  };
  host.addFeature(
    HOST.LipsyncFeature,
    false,
    visemeOptions,
    talkingOptions
  );

  // Set up Gestures
  host.addFeature(HOST.GestureFeature, false, {
    layers: {
      Gesture: {minimumInterval: 3},
      Emote: {
        blendTime: 0.5,
        easingFn: HOST.anim.Easing.Quadratic.InOut,
      },
    },
  });

  // Set up Point of Interest
  host.addFeature(
    HOST.PointOfInterestFeature,
    false,
    {
      target: camera,
      lookTracker: lookJoint,
      scene,
    },
    {
      layers: poiConfig,
    },
    {
      layers: [{name: 'Blink'}],
    }
  );

  return host;
}

// Return the host whose name matches the text of the current tab
function getCurrentHost() {
  const name = "Luke";

  return {name, host: speakers.get(name)};
}

// Update UX with data for the current host
function toggleHost(evt) {
  const tab = evt.target;
  const allTabs = document.getElementsByClassName('tab');

  // Update tab classes
  for (let i = 0, l = allTabs.length; i < l; i++) {
    if (allTabs[i] !== tab) {
      allTabs[i].classList.remove('current');
    } else {
      allTabs[i].classList.add('current');
    }
  }

  // Show/hide speech input classes
  const {name, host} = getCurrentHost(speakers);
  const textEntries = document.getElementsByClassName('textEntry');

  for (let i = 0, l = textEntries.length; i < l; i += 1) {
    const textEntry = textEntries[i];

    if (textEntry.classList.contains(name)) {
      textEntry.classList.remove('hidden');
    } else {
      textEntry.classList.add('hidden');
    }
  }

  // Update emote selector
  const emoteSelect = document.getElementById('emotes');
  emoteSelect.length = 0;
  const emotes = host.AnimationFeature.getAnimations('Emote');
  emotes.forEach((emote, i) => {
    const emoteOption = document.createElement('option');
    emoteOption.text = emote;
    emoteOption.value = emote;
    emoteSelect.add(emoteOption, 0);

    // Set the current item to the first emote
    if (!i) {
      emoteSelect.value = emote;
    }
  });
}

function initializeUX(speakers) {
  // // Enable drag/drop text files on the speech text area
  // enableDragDrop('textEntry');
  //
  // // Play, pause, resume and stop the contents of the text input as speech
  // // when buttons are clicked
  // ['play', 'pause', 'resume', 'stop'].forEach(id => {
  //   const button = document.getElementById(id);
  //   button.onclick = () => {
  //     const {name, host} = getCurrentHost(speakers);
  //     const speechInput = document.getElementsByClassName(
  //       `textEntry ${name}`
  //     )[0];
  //     host.TextToSpeechFeature[id](speechInput.value);
  //   };
  // });
  //
  // // Update the text area text with gesture SSML markup when clicked
  // const gestureButton = document.getElementById('gestures');
  // gestureButton.onclick = () => {
  //   const {name, host} = getCurrentHost(speakers);
  //   const speechInput = document.getElementsByClassName(
  //     `textEntry ${name}`
  //   )[0];
  //   const gestureMap = host.GestureFeature.createGestureMap();
  //   const gestureArray = host.GestureFeature.createGenericGestureArray([
  //     'Gesture',
  //   ]);
  //   speechInput.value = HOST.aws.TextToSpeechUtils.autoGenerateSSMLMarks(
  //     speechInput.value,
  //     gestureMap,
  //     gestureArray
  //   );
  // };
  //
  // // Play emote on demand with emote button
  // const emoteSelect = document.getElementById('emotes');
  // const emoteButton = document.getElementById('playEmote');
  // emoteButton.onclick = () => {
  //   const {host} = getCurrentHost(speakers);
  //   host.GestureFeature.playGesture('Emote', emoteSelect.value);
  // };
  //
  // // Initialize tab
  // const tab = document.getElementsByClassName('tab current')[0];
  // toggleHost({target: tab});
}

function enableDragDrop(className) {
  const elements = document.getElementsByClassName(className);

  for (let i = 0, l = elements.length; i < l; i += 1) {
    const dropArea = elements[i];

    // Copy contents of files into the text input once they are read
    const fileReader = new FileReader();
    fileReader.onload = evt => {
      dropArea.value = evt.target.result;
    };

    // Drag and drop listeners
    dropArea.addEventListener('dragover', evt => {
      evt.stopPropagation();
      evt.preventDefault();
      evt.dataTransfer.dropEffect = 'copy';
    });

    dropArea.addEventListener('drop', evt => {
      evt.stopPropagation();
      evt.preventDefault();

      // Read the first file that was dropped
      const [file] = evt.dataTransfer.files;
      fileReader.readAsText(file, 'UTF-8');
    });
  }
}


async function main(callback) {

  window.AWS.config.region = 'eu-west-1';
  window.AWS.config.credentials = new AWS.CognitoIdentityCredentials({
    IdentityPoolId: 'eu-west-1:292b851e-196b-4148-b7fd-ad6c711be793',
  });

  const polly = new AWS.Polly();


  // Initialize AWS and create Polly service objects
  const presigner = new AWS.Polly.Presigner();


  const speechInit = HOST.aws.TextToSpeechFeature.initializeService(
    polly,
    presigner,
    window.AWS.VERSION
  );

  // Define the glTF assets that will represent the host
  const characterFile1 =
    './assets/glTF/characters/adult_male/luke/luke.gltf';
  const animationPath1 = './assets/glTF/animations/adult_male';
  const animationFiles = [
    'stand_idle.glb',
    'lipsync.glb',
    'gesture.glb',
    'emote.glb',
    'face_idle.glb',
    'blink.glb',
    'poi.glb',
  ];
  const gestureConfigFile = 'gesture.json';
  const poiConfigFile = 'poi.json';
  const audioAttachJoint1 = 'chardef_c_neckB'; // Name of the joint to attach audio to
  const lookJoint1 = 'charjx_c_look'; // Name of the joint to use for point of interest target tracking
  const voice1 = 'Matthew'; // Polly voice. Full list of available voices at: https://docs.aws.amazon.com/polly/latest/dg/voicelist.html
  const voiceEngine = 'neural'; // Neural engine is not available for all voices in all regions: https://docs.aws.amazon.com/polly/latest/dg/NTTS-main.html

  // Set up the scene and host
  const {scene, camera, clock} = createScene();
  const {
    character: character1,
    clips: clips1,
    bindPoseOffset: bindPoseOffset1,
  } = await loadCharacter(
    scene,
    characterFile1,
    animationPath1,
    animationFiles
  );

  character1.position.set(0, 0, 0);
  character1.rotateY(-0.2);

  // Find the joints defined by name
  const audioAttach1 = character1.getObjectByName(audioAttachJoint1);
  const lookTracker1 = character1.getObjectByName(lookJoint1);

  // Read the gesture config file. This file contains options for splitting up
  // each animation in gestures.glb into 3 sub-animations and initializing them
  // as a QueueState animation.
  const gestureConfig1 = await fetch(
    `${animationPath1}/${gestureConfigFile}`
  ).then(response => response.json());

  // Read the point of interest config file. This file contains options for
  // creating Blend2dStates from look pose clips and initializing look layers
  // on the PointOfInterestFeature.
  const poiConfig1 = await fetch(
    `${animationPath1}/${poiConfigFile}`
  ).then(response => response.json());

  const [
    idleClips1,
    lipsyncClips1,
    gestureClips1,
    emoteClips1,
    faceClips1,
    blinkClips1,
    poiClips1,
  ] = clips1;
  const host1 = createHost(
    character1,
    audioAttach1,
    voice1,
    voiceEngine,
    idleClips1[0],
    faceClips1[0],
    lipsyncClips1,
    gestureClips1,
    gestureConfig1,
    emoteClips1,
    blinkClips1,
    poiClips1,
    poiConfig1,
    lookTracker1,
    bindPoseOffset1,
    clock,
    camera,
    scene
  );

  // Set up each host to look at the other when the other speaks and at the
  // camera when speech ends
  const onHost1StartSpeech = () => {
  };
  const onStopSpeech = () => {
    host1.PointOfInterestFeature.setTarget(camera);
  };

  host1.listenTo(
    host1.TextToSpeechFeature.EVENTS.play,
    onHost1StartSpeech
  );
  host1.listenTo(
    host1.TextToSpeechFeature.EVENTS.resume,
    onHost1StartSpeech
  );
  HOST.aws.TextToSpeechFeature.listenTo(
    HOST.aws.TextToSpeechFeature.EVENTS.pause,
    onStopSpeech
  );
  HOST.aws.TextToSpeechFeature.listenTo(
    HOST.aws.TextToSpeechFeature.EVENTS.stop,
    onStopSpeech
  );

  callback(true);

  document.getElementById('renderCanvas').style.display = '';

  await speechInit;

  speakers.set('Luke', host1);

  initializeUX();
}


Amplify.configure(awsconfig);

const renderFn = [];
const speakers = new Map([['Luke', undefined]]);

function App() {

  const [loaderScreen, setLoaderScreen] = useState(false);

  function handleClick(e) {
    e.preventDefault();

    const {name, host} = getCurrentHost(speakers);
    const speechInput = "<speak>Hi Friends. Here is a number <w role='amazon:VBD'>read</w>as a cardinal number: <say-as interpret-as='cardinal'>12345</say-as>. Here is a word spelled out: <say-as interpret-as='spell-out'>hello</say-as>.</speak>"

    const emotes = host.AnimationFeature.getAnimations('Emote');
    console.log("emotes", emotes)

    host.TextToSpeechFeature.play(speechInput).then(response => {
      console.log("Completed");
    }).catch(e => {
      console.log("Error TexttoSpeech");
    });
    //host.GestureFeature.playGesture('Emote', "cheer");
  }

  useEffect(() => {
    main(setLoaderScreen);
  }, []); // Only re-run the effect if count changes

  return (
    <div id="container" style={{height:"100%"}}>
      {!loaderScreen &&
      <div id="loadScreen">
        <div id="loader"></div>
      </div>
      }
      {loaderScreen &&
      <div id="startTalking">
        <a href="#" onClick={handleClick}>
          Start session....
        </a>
      </div>
      }
    </div>
  );
}

export default App;
