package com.example.labourattendance

import android.app.DatePickerDialog
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.os.Bundle
import android.text.Editable
import android.text.TextWatcher
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.*
import androidx.activity.enableEdgeToEdge
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import com.example.labourattendance.databinding.ActivityDispatchBinding
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.FirebaseFirestore
import java.text.SimpleDateFormat
import java.util.*

class DispatchActivity : AppCompatActivity() {

    private lateinit var binding: ActivityDispatchBinding
    private lateinit var databaseHelper: DatabaseHelper
    private val db = FirebaseFirestore.getInstance()
    private val auth = FirebaseAuth.getInstance()
    private val calendar = Calendar.getInstance()
    private val dbDateFormat = SimpleDateFormat("yyyy-MM-dd", Locale.US)
    private val dbDateTimeFormat = SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.US)
    
    private var allDispatches: List<DatabaseHelper.DispatchRecord> = emptyList()
    private var currentSearchQuery: String = ""
    private fun tenantDispatches() = db.collection("workspaces")
        .document(requireNotNull(auth.currentUser?.uid) { "Authenticated tenant is required." })
        .collection("dispatches")

    private fun getUiDateTimeFormat(): SimpleDateFormat {
        val lang = getSharedPreferences("Settings", MODE_PRIVATE).getString("My_Lang", "en")
        return if (lang == "en") SimpleDateFormat("dd-MM-yyyy", Locale.US) else SimpleDateFormat("yyyy-MM-dd", Locale.getDefault())
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        loadLocale()
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        binding = ActivityDispatchBinding.inflate(layoutInflater)
        setContentView(binding.root)

        val initialPaddingLeft = binding.root.paddingLeft
        val initialPaddingTop = binding.root.paddingTop
        val initialPaddingRight = binding.root.paddingRight
        val initialPaddingBottom = binding.root.paddingBottom

        ViewCompat.setOnApplyWindowInsetsListener(binding.root) { v, insets ->
            val systemBars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            v.setPadding(
                initialPaddingLeft + systemBars.left,
                initialPaddingTop + systemBars.top,
                initialPaddingRight + systemBars.right,
                initialPaddingBottom + systemBars.bottom
            )
            insets
        }

        databaseHelper = DatabaseHelper(this)

        binding.buttonManageVehicles.setOnClickListener { showManageVehiclesDialog() }
        binding.buttonManageDateTypes.setOnClickListener { showManageDateTypesDialog() }
        binding.buttonNewDispatch.setOnClickListener { showNewDispatchDialog() }
        binding.buttonDispatchReport.setOnClickListener {
            startActivity(Intent(this, DispatchReportActivity::class.java))
        }

        binding.imageViewClearSearch.setOnClickListener {
            binding.editTextSearchDispatch.text.clear()
            currentSearchQuery = ""
            filterAndDisplay()
        }

        binding.editTextSearchDispatch.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {
                currentSearchQuery = s?.toString()?.trim() ?: ""
                binding.imageViewClearSearch.visibility = if (currentSearchQuery.isEmpty()) View.GONE else View.VISIBLE
                filterAndDisplay()
            }
            override fun afterTextChanged(s: Editable?) {}
        })

        setupRoleBasedUI()
        observeCloudDispatches()
    }

    private fun setupRoleBasedUI() {
        val role = getSharedPreferences("Settings", MODE_PRIVATE).getString("User_Role", "viewer")
        val isClosed = databaseHelper.isCurrentSeasonClosed()
        
        if (role == "viewer" || isClosed) {
            binding.buttonNewDispatch.visibility = View.GONE
            binding.buttonManageVehicles.visibility = View.GONE
            binding.buttonManageDateTypes.visibility = View.GONE
        } else {
            binding.buttonNewDispatch.visibility = View.VISIBLE
            binding.buttonManageVehicles.visibility = View.VISIBLE
            binding.buttonManageDateTypes.visibility = View.VISIBLE
        }
    }

    private fun observeCloudDispatches() {
        tenantDispatches()
            .orderBy("timestamp", com.google.firebase.firestore.Query.Direction.DESCENDING)
            .limit(50)
            .addSnapshotListener { snapshots, e ->
                if (e != null) return@addSnapshotListener
                
                if (snapshots != null) {
                    allDispatches = snapshots.documents.map { doc ->
                        val vehicleNumber = doc.getString("vehicleNumber") ?: ""
                        val driverName = doc.getString("driverName") ?: ""
                        val date = doc.getString("date") ?: ""
                        val itemsList = doc.get("items") as? List<*> ?: emptyList<Any>()
                        val items = itemsList.mapNotNull { item ->
                            val map = item as? Map<*, *>
                            if (map != null) {
                                DatabaseHelper.DispatchItem(
                                    dateTypeName = map["typeName"] as? String ?: "",
                                    cartonCount = (map["count"] as? Long ?: 0).toInt(),
                                    dateTypeId = 0
                                )
                            } else null
                        }
                        DatabaseHelper.DispatchRecord(
                            id = (doc.get("localId") as? Long ?: 0).toInt(),
                            vehicleId = 0,
                            vehicleNumber = vehicleNumber,
                            driverName = driverName,
                            date = date,
                            cloudId = doc.id,
                            items = items
                        )
                    }
                    filterAndDisplay()
                }
            }
    }

    private fun filterAndDisplay() {
        val filtered = if (currentSearchQuery.isEmpty()) {
            allDispatches
        } else {
            allDispatches.filter { d ->
                d.vehicleNumber.contains(currentSearchQuery, ignoreCase = true) ||
                d.driverName.contains(currentSearchQuery, ignoreCase = true) ||
                d.items.any { it.dateTypeName.contains(currentSearchQuery, ignoreCase = true) }
            }
        }
        displayDispatches(filtered)
    }

    private fun displayDispatches(dispatches: List<DatabaseHelper.DispatchRecord>) {
        binding.dispatchListContainer.removeAllViews()

        if (dispatches.isEmpty()) {
            val tv = TextView(this).apply {
                text = if (currentSearchQuery.isEmpty()) getString(R.string.msg_no_dispatches) else "No matching dispatches"
                gravity = Gravity.CENTER
                setPadding(0, dpToPx(40), 0, 0)
                setTextColor(Color.parseColor("#475467"))
                textSize = 15f
            }
            binding.dispatchListContainer.addView(tv)
            return
        }

        dispatches.forEach { dispatch ->
            val card = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(dpToPx(12), dpToPx(10), dpToPx(12), dpToPx(10))
                setBackgroundResource(R.drawable.bg_card)
                layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                    bottomMargin = dpToPx(8)
                }
                elevation = dpToPx(1).toFloat()
            }

            val topRow = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
            }

            val parsed = try { dbDateTimeFormat.parse(dispatch.date) } catch (_: Exception) { dbDateFormat.parse(dispatch.date) }
            val displayDate = if (parsed != null) getUiDateTimeFormat().format(parsed) else dispatch.date

            val vehicleInfo = TextView(this).apply {
                text = "$displayDate | ${dispatch.vehicleNumber}"
                textSize = 15f
                setTextColor(Color.parseColor("#002B4E"))
                setTypeface(null, Typeface.BOLD)
                layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
            }

            topRow.addView(vehicleInfo)

            val role = getSharedPreferences("Settings", MODE_PRIVATE).getString("User_Role", "viewer")
            if (role != "viewer") {
                val isClosed = databaseHelper.isCurrentSeasonClosed()
                if (role == "admin" && !isClosed) {
                    val editBtn = Button(this).apply {
                        text = getString(R.string.btn_update)
                        setTextColor(Color.parseColor("#004EEB"))
                        background = null
                        textSize = 11f
                        minHeight = 0
                        minWidth = 0
                        setPadding(dpToPx(8), dpToPx(4), dpToPx(8), dpToPx(4))
                        layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT)
                        setOnClickListener { showEditDispatchDialog(dispatch) }
                    }
                    topRow.addView(editBtn)
                }

                if (role == "admin" && !isClosed) {
                    val delBtn = Button(this).apply {
                        text = "X"
                        setTextColor(Color.RED)
                        background = null
                        textSize = 12f
                        minHeight = 0
                        minWidth = 0
                        setPadding(dpToPx(8), dpToPx(4), dpToPx(8), dpToPx(4))
                        layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT)
                        setOnClickListener {
                            MaterialAlertDialogBuilder(this@DispatchActivity, R.style.AppAlertDialogTheme)
                                .setTitle("Delete Dispatch")
                                .setMessage("Are you sure you want to delete this dispatch?")
                                .setPositiveButton("Delete") { _, _ ->
                                    databaseHelper.deleteDispatch(dispatch.id)
                                    dispatch.cloudId?.let { cid ->
                                        tenantDispatches().document(cid).delete()
                                    }
                                }
                                .setNegativeButton("Cancel", null)
                                .show()
                        }
                    }
                    topRow.addView(delBtn)
                }
            }

            card.addView(topRow)

            val totalCartons = dispatch.items.sumOf { it.cartonCount }
            val itemsText = dispatch.items.joinToString(", ") { "${it.dateTypeName}: ${it.cartonCount}" }
            
            val body = TextView(this).apply {
                val totalLabel = getString(R.string.label_total_cartons, totalCartons)
                text = "$itemsText [$totalLabel]"
                textSize = 13f
                setTextColor(Color.parseColor("#475467"))
                setPadding(0, dpToPx(2), 0, 0)
            }
            card.addView(body)

            binding.dispatchListContainer.addView(card)
        }
    }

    private fun showEditDispatchDialog(record: DatabaseHelper.DispatchRecord) {
        val vehicles = databaseHelper.getAllVehicles()
        val dateTypes = databaseHelper.getAllDateTypes()
        
        val dialogView = layoutInflater.inflate(R.layout.dialog_add_dispatch, null)
        val spinnerVehicle = dialogView.findViewById<Spinner>(R.id.spinnerVehicle)
        val itemsContainer = dialogView.findViewById<LinearLayout>(R.id.itemsContainer)
        val buttonAddItem = dialogView.findViewById<Button>(R.id.buttonAddItem)
        val buttonSelectDate = dialogView.findViewById<Button>(R.id.buttonSelectDate)

        val vehicleAdapter = ArrayAdapter(this, R.layout.spinner_item, vehicles.map { "${it.number} (${it.driverName})" })
        spinnerVehicle.adapter = vehicleAdapter
        
        val currentVehicleIndex = vehicles.indexOfFirst { it.id == record.vehicleId }
        if (currentVehicleIndex != -1) spinnerVehicle.setSelection(currentVehicleIndex)

        var dispatchDate = record.date
        val parsed = try { dbDateTimeFormat.parse(record.date) } catch (_: Exception) { dbDateFormat.parse(record.date) }
        buttonSelectDate.text = if (parsed != null) getUiDateTimeFormat().format(parsed) else record.date

        buttonSelectDate.setOnClickListener {
            val c = Calendar.getInstance()
            if (parsed != null) c.time = parsed
            DatePickerDialog(this, { _, y, m, d ->
                c.set(y, m, d)
                dispatchDate = dbDateTimeFormat.format(c.time)
                buttonSelectDate.text = getUiDateTimeFormat().format(c.time)
            }, c.get(Calendar.YEAR), c.get(Calendar.MONTH), c.get(Calendar.DAY_OF_MONTH)).show()
        }

        fun addItemRow(item: DatabaseHelper.DispatchItem? = null) {
            val row = layoutInflater.inflate(R.layout.row_dispatch_item, null) as LinearLayout
            val spinnerType = row.findViewById<Spinner>(R.id.spinnerDateType)
            val editCount = row.findViewById<EditText>(R.id.editCartonCount)
            
            val typeAdapter = ArrayAdapter(this, R.layout.spinner_item, dateTypes.map { it.name })
            spinnerType.adapter = typeAdapter
            
            if (item != null) {
                val typeIndex = dateTypes.indexOfFirst { it.name == item.dateTypeName }
                if (typeIndex != -1) spinnerType.setSelection(typeIndex)
                editCount.setText(item.cartonCount.toString())
            }

            row.findViewById<ImageButton>(R.id.buttonRemoveItem).setOnClickListener {
                itemsContainer.removeView(row)
            }
            itemsContainer.addView(row)
        }

        if (record.items.isEmpty()) addItemRow() else record.items.forEach { addItemRow(it) }
        buttonAddItem.setOnClickListener { addItemRow() }

        MaterialAlertDialogBuilder(this, R.style.AppAlertDialogTheme)
            .setTitle(R.string.title_update_record)
            .setView(dialogView)
            .setPositiveButton(R.string.btn_update) { _, _ ->
                val vehicle = vehicles[spinnerVehicle.selectedItemPosition]
                val items = mutableListOf<DatabaseHelper.DispatchItem>()
                for (i in 0 until itemsContainer.childCount) {
                    val row = itemsContainer.getChildAt(i)
                    val spinnerType = row.findViewById<Spinner>(R.id.spinnerDateType)
                    val editCount = row.findViewById<EditText>(R.id.editCartonCount)
                    val type = dateTypes[spinnerType.selectedItemPosition]
                    val count = editCount.text.toString().toIntOrNull() ?: 0
                    if (count > 0) items.add(DatabaseHelper.DispatchItem(dateTypeId = type.id, dateTypeName = type.name, cartonCount = count))
                }
                
                if (items.isNotEmpty()) {
                    // We need an updateDispatch method in DatabaseHelper. Since it's missing, let's just re-use delete/add logic for simplicity in sync
                    databaseHelper.deleteDispatch(record.id)
                    val newId = databaseHelper.addDispatch(vehicle.id, dispatchDate, items)
                    
                    // Cloud update
                    record.cloudId?.let { cid -> tenantDispatches().document(cid).delete() }
                    uploadDispatchToCloud(newId, vehicle, dispatchDate, items)
                    
                    Toast.makeText(this, R.string.toast_update_success, Toast.LENGTH_SHORT).show()
                }
            }
            .setNegativeButton(R.string.btn_cancel, null)
            .show()
    }

    private fun showManageVehiclesDialog() {
        val list = databaseHelper.getAllVehicles()
        val names = list.map { "${it.number} - ${it.driverName}" }.toTypedArray()

        com.google.android.material.dialog.MaterialAlertDialogBuilder(this, R.style.AppAlertDialogTheme)
            .setTitle(R.string.btn_vehicles)
            .setItems(names) { _, which ->
                val vehicle = list[which]
                val options = arrayOf(getString(R.string.btn_update), getString(R.string.btn_delete))
                MaterialAlertDialogBuilder(this, R.style.AppAlertDialogTheme)
                    .setTitle(vehicle.number)
                    .setItems(options) { _, optionIndex ->
                        when (optionIndex) {
                            0 -> showEditVehicleDialog(vehicle)
                            1 -> {
                                MaterialAlertDialogBuilder(this, R.style.AppAlertDialogTheme)
                                    .setTitle("Delete Vehicle?")
                                    .setMessage("Remove ${vehicle.number}?")
                                    .setPositiveButton("Delete") { _, _ ->
                                        databaseHelper.deleteVehicle(vehicle.id)
                                        showManageVehiclesDialog()
                                    }
                                    .setNegativeButton("Cancel", null)
                                    .show()
                            }
                        }
                    }
                    .show()
            }
            .setPositiveButton(R.string.btn_add) { _, _ -> showAddVehicleDialog() }
            .setNegativeButton(R.string.btn_back, null)
            .show()
    }

    private fun showEditVehicleDialog(vehicle: DatabaseHelper.Vehicle) {
        val container = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dpToPx(24), dpToPx(16), dpToPx(24), dpToPx(16))
        }

        val editNumber = createEditText(R.string.hint_vehicle_number).apply { setText(vehicle.number) }
        val editDriver = createEditText(R.string.hint_driver_name).apply { setText(vehicle.driverName) }
        val editPhone = createEditText(R.string.hint_driver_phone).apply {
            setText(vehicle.driverPhone)
            inputType = android.text.InputType.TYPE_CLASS_PHONE
        }

        container.addView(editNumber)
        container.addView(editDriver)
        container.addView(editPhone)

        MaterialAlertDialogBuilder(this, R.style.AppAlertDialogTheme)
            .setTitle("Update Vehicle")
            .setView(container)
            .setPositiveButton(R.string.btn_update) { _, _ ->
                val n = editNumber.text.toString().trim()
                val d = editDriver.text.toString().trim()
                val p = editPhone.text.toString().trim()
                if (n.isNotEmpty()) {
                    databaseHelper.updateVehicle(vehicle.id, n, d, p)
                    showManageVehiclesDialog()
                }
            }
            .setNegativeButton(R.string.btn_cancel, null)
            .show()
    }

    private fun showAddVehicleDialog() {
        val container = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dpToPx(24), dpToPx(16), dpToPx(24), dpToPx(16))
        }

        val editNumber = createEditText(R.string.hint_vehicle_number)
        val editDriver = createEditText(R.string.hint_driver_name)
        val editPhone = createEditText(R.string.hint_driver_phone)
        editPhone.inputType = android.text.InputType.TYPE_CLASS_PHONE

        container.addView(editNumber)
        container.addView(editDriver)
        container.addView(editPhone)

        com.google.android.material.dialog.MaterialAlertDialogBuilder(this, R.style.AppAlertDialogTheme)
            .setTitle(R.string.title_new_vehicle)
            .setView(container)
            .setPositiveButton(R.string.btn_add) { _, _ ->
                val n = editNumber.text.toString()
                val d = editDriver.text.toString()
                val p = editPhone.text.toString()
                if (n.isNotEmpty()) {
                    databaseHelper.addVehicle(n, d, p)
                    showManageVehiclesDialog()
                }
            }
            .setNegativeButton(R.string.btn_cancel, null)
            .show()
    }

    private fun showManageDateTypesDialog() {
        val list = databaseHelper.getAllDateTypes()
        val names = list.map { it.name }.toTypedArray()

        com.google.android.material.dialog.MaterialAlertDialogBuilder(this, R.style.AppAlertDialogTheme)
            .setTitle(R.string.btn_date_types)
            .setItems(names) { _, which ->
                val dt = list[which]
                com.google.android.material.dialog.MaterialAlertDialogBuilder(this, R.style.AppAlertDialogTheme)
                    .setTitle("Delete Type?")
                    .setMessage("Remove ${dt.name}?")
                    .setPositiveButton("Delete") { _, _ ->
                        databaseHelper.deleteDateType(dt.id)
                        showManageDateTypesDialog()
                    }
                    .setNegativeButton("Cancel", null)
                    .show()
            }
            .setPositiveButton(R.string.btn_add) { _, _ -> showAddDateTypeDialog() }
            .setNegativeButton(R.string.btn_back, null)
            .show()
    }

    private fun showAddDateTypeDialog() {
        val container = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dpToPx(24), dpToPx(16), dpToPx(24), dpToPx(16))
        }
        val edit = createEditText(R.string.hint_date_type_name)
        container.addView(edit)

        com.google.android.material.dialog.MaterialAlertDialogBuilder(this, R.style.AppAlertDialogTheme)
            .setTitle(R.string.title_new_date_type)
            .setView(container)
            .setPositiveButton(R.string.btn_add) { _, _ ->
                val n = edit.text.toString()
                if (n.isNotEmpty()) {
                    databaseHelper.addDateType(n)
                    showManageDateTypesDialog()
                }
            }
            .setNegativeButton(R.string.btn_cancel, null)
            .show()
    }

    private fun showNewDispatchDialog() {
        val vehicles = databaseHelper.getAllVehicles()
        if (vehicles.isEmpty()) {
            Toast.makeText(this, "Add a vehicle first", Toast.LENGTH_SHORT).show()
            return
        }

        val dateTypes = databaseHelper.getAllDateTypes()
        if (dateTypes.isEmpty()) {
            Toast.makeText(this, "Add types first", Toast.LENGTH_SHORT).show()
            return
        }

        val dialogView = layoutInflater.inflate(R.layout.dialog_add_dispatch, null)
        val spinnerVehicle = dialogView.findViewById<Spinner>(R.id.spinnerVehicle)
        val itemsContainer = dialogView.findViewById<LinearLayout>(R.id.itemsContainer)
        val buttonAddItem = dialogView.findViewById<Button>(R.id.buttonAddItem)
        val buttonSelectDate = dialogView.findViewById<Button>(R.id.buttonSelectDate)

        val vehicleAdapter = ArrayAdapter(this, R.layout.spinner_item, vehicles.map { "${it.number} (${it.driverName})" })
        spinnerVehicle.adapter = vehicleAdapter

        var dispatchDate = dbDateTimeFormat.format(Date())
        buttonSelectDate.text = getUiDateTimeFormat().format(Date())
        buttonSelectDate.setOnClickListener {
            DatePickerDialog(this, { _, y, m, d ->
                val c = Calendar.getInstance()
                c.set(y, m, d)
                val now = Calendar.getInstance()
                c.set(Calendar.HOUR_OF_DAY, now.get(Calendar.HOUR_OF_DAY))
                c.set(Calendar.MINUTE, now.get(Calendar.MINUTE))
                c.set(Calendar.SECOND, now.get(Calendar.SECOND))
                
                dispatchDate = dbDateTimeFormat.format(c.time)
                buttonSelectDate.text = getUiDateTimeFormat().format(c.time)
            }, calendar.get(Calendar.YEAR), calendar.get(Calendar.MONTH), calendar.get(Calendar.DAY_OF_MONTH)).show()
        }

        fun addItemRow() {
            val row = layoutInflater.inflate(R.layout.row_dispatch_item, null) as LinearLayout
            val spinnerType = row.findViewById<Spinner>(R.id.spinnerDateType)
            val typeAdapter = ArrayAdapter(this, R.layout.spinner_item, dateTypes.map { it.name })
            spinnerType.adapter = typeAdapter
            
            row.findViewById<ImageButton>(R.id.buttonRemoveItem).setOnClickListener {
                itemsContainer.removeView(row)
            }
            itemsContainer.addView(row)
        }

        addItemRow()
        buttonAddItem.setOnClickListener { addItemRow() }

        com.google.android.material.dialog.MaterialAlertDialogBuilder(this, R.style.AppAlertDialogTheme)
            .setTitle(R.string.btn_new_dispatch)
            .setView(dialogView)
            .setPositiveButton(R.string.btn_save_dispatch) { _, _ ->
                val vehicle = vehicles[spinnerVehicle.selectedItemPosition]
                val items = mutableListOf<DatabaseHelper.DispatchItem>()
                
                for (i in 0 until itemsContainer.childCount) {
                    val row = itemsContainer.getChildAt(i)
                    val spinnerType = row.findViewById<Spinner>(R.id.spinnerDateType)
                    val editCount = row.findViewById<EditText>(R.id.editCartonCount)
                    
                    val type = dateTypes[spinnerType.selectedItemPosition]
                    val count = editCount.text.toString().toIntOrNull() ?: 0
                    if (count > 0) {
                        items.add(DatabaseHelper.DispatchItem(dateTypeId = type.id, dateTypeName = type.name, cartonCount = count))
                    }
                }
                
                if (items.isNotEmpty()) {
                    val dispatchId = databaseHelper.addDispatch(vehicle.id, dispatchDate, items)
                    if (dispatchId != -1L) {
                        uploadDispatchToCloud(dispatchId, vehicle, dispatchDate, items)
                        Toast.makeText(this, "Dispatch saved", Toast.LENGTH_SHORT).show()
                    }
                }
            }
            .setNegativeButton(R.string.btn_cancel, null)
            .show()
    }

    private fun uploadDispatchToCloud(localId: Long, vehicle: DatabaseHelper.Vehicle, date: String, items: List<DatabaseHelper.DispatchItem>) {
        val dispatchData = hashMapOf(
            "localId" to localId,
            "vehicleNumber" to vehicle.number,
            "driverName" to vehicle.driverName,
            "driverPhone" to vehicle.driverPhone,
            "date" to date,
            "items" to items.map { 
                hashMapOf(
                    "typeName" to it.dateTypeName,
                    "count" to it.cartonCount
                )
            },
            "timestamp" to com.google.firebase.Timestamp.now()
        )

        tenantDispatches().add(dispatchData)
    }

    private fun createEditText(hintRes: Int): EditText {
        return EditText(this).apply {
            setHint(hintRes)
            setTextColor(Color.parseColor("#101828"))
            setHintTextColor(Color.parseColor("#667085"))
            setBackgroundResource(R.drawable.bg_input)
            setPadding(dpToPx(16), dpToPx(12), dpToPx(16), dpToPx(12))
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                bottomMargin = dpToPx(12)
            }
        }
    }

    private fun dpToPx(dp: Int): Int = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, dp.toFloat(), resources.displayMetrics).toInt()

    private fun loadLocale() {
        val prefs = getSharedPreferences("Settings", MODE_PRIVATE)
        val lang = prefs.getString("My_Lang", "en") ?: "en"
        val locale = Locale(lang)
        Locale.setDefault(locale)
        val config = android.content.res.Configuration()
        config.setLocale(locale)
        if (lang == "ar" || lang == "ur") config.setLayoutDirection(locale) else config.setLayoutDirection(Locale.ENGLISH)
        @Suppress("DEPRECATION")
        resources.updateConfiguration(config, resources.displayMetrics)
    }
}
